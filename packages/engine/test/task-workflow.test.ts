// 任务工作流（workflows/task.ts，#632 S2-4）：真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。
// 走通的：一张单从动手到合并、关单；返工（没提交、CI 红、验收没过）；换路由；停下等人（交代不全、验收做不出来、改标准、
// 动手几轮都不过、PR 被关）；放弃（停着时、会话跑着时）。故意造的失败：没装任务活动（不许装作做过）。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, fakeHead } from '../src/fakes.ts';
import type { PickRouteInput, RouteChoice } from '../src/ports.ts';
import {
  type RunSegmentResult,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskContinueSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, waitUntil, withWorker } from './helpers.ts';
import { goodBrief, OK_SEGMENT, scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

function input(over: Partial<TaskWorkflowInput> = {}): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    title: '给驾驶舱加状态',
    ...over,
  };
}

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber),
    args: [i],
  });
}

const statusOf = (h: WorkflowHandle): Promise<TaskStatus> => h.query(taskStatusQuery);

const statusUntil = (h: WorkflowHandle, check: (s: TaskStatus) => boolean, what: string) =>
  pollQuery(() => statusOf(h), check, what);

const parked = (s: TaskStatus) => s.waiting?.kind === 'human';

describe('任务工作流 · 走通', { timeout: 60_000 }, () => {
  it('一张单：选路、建树、动手、读交付、推分支、开 PR、等 CI、验收、挂自动合并、等合并、关单、收树', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted();
    const i = input();
    const run = await withWorker(env, world, async (q) => (await start(q, i)).result() as Promise<TaskRun>, {
      tasks,
    });
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, verifyRounds: 1 });
    expect(run.prNumber).toBeGreaterThan(0);
    // 交代：动手会话拿到的是读出来的交代、选的是第一条路由、分档记着
    expect(calls.segment).toHaveLength(1);
    expect(calls.segment[0]).toMatchObject({
      taskId: i.taskId,
      route: { routeId: 'r1' },
      tier: { tier: 'medium' },
      feedback: [],
    });
    expect(calls.verify[0]).toMatchObject({ prNumber: run.prNumber, round: 1, authorFamilies: ['claude'] });
    expect(calls.arm).toBe(1);
    // 活动的先后：读交代 → 动手 → 读交付 → 验收 → 查路径 → 挂自动合并 → 等合并（验收一定在挂之前）
    expect(calls.order).toEqual(['brief', 'segment', 'delivery', 'verify', 'guarded', 'arm', 'merged']);
    // 端口：建树一次、推分支一次、开 PR 一次、关单（完成）、收树（不存档）
    expect(world.count('createWorktree')).toBe(1);
    expect(world.count('pushBranch')).toBe(1);
    expect(world.count('openPr')).toBe(1);
    expect(world.callsOf('closeIssue')[0]?.input).toMatchObject({ issueNumber: 12, reason: 'completed' });
    expect(world.callsOf('removeWorktree')[0]?.input).toMatchObject({ archive: false });
    // 挂自动合并在验收通过之后（calls 里先 verify 后 arm）；写给驾驶舱的状态：先 running、最后 done
    expect(world.states[0]).toMatchObject({ state: 'running', issueNumber: 12 });
    expect(world.states.at(-1)).toMatchObject({ state: 'done' });
    expect(world.alerts).toEqual([]);
  });

  it('CI 红了：失败信息带进下一轮动手，PR 只开一次，推两次', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL task.test.ts' } : undefined,
    });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[0]?.feedback).toEqual([]);
    expect(calls.segment[1]?.feedback.join('\n')).toContain('test (engine)');
    expect(calls.segment[1]?.feedback.join('\n')).toContain('FAIL task.test.ts');
    expect(world.count('openPr')).toBe(1);
    expect(world.count('pushBranch')).toBe(2);
    // 第二轮的交付检查从上一轮推上去的头起算，不是从最初的起点
    expect(calls.segment[1]?.baseSha).not.toBe(calls.segment[0]?.baseSha);
  });

  it('会话跑完没有提交：不推、不开 PR，意见是「没有提交」，下一轮再来', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      delivery: (n) => ({
        head: fakeHead(200 + n),
        commits: n === 1 ? 0 : 1,
        changedFiles: n === 1 ? [] : ['a.ts'],
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.segment[1]?.feedback.join('\n')).toContain('没有产生新的提交');
    expect(world.count('pushBranch')).toBe(1);
    expect(world.count('openPr')).toBe(1);
  });

  it('验收没过：问题表带进下一轮；第二轮验收通过再合并', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      verify: (_i, n) =>
        n === 1
          ? { pass: false, problems: ['没做到验收条：页面上看不到「验收中」'], round: 1 }
          : { pass: true, problems: [], round: 2 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2, verifyRounds: 2 });
    expect(calls.segment[1]?.feedback.join('\n')).toContain('没做到验收条');
    expect(calls.verify.map((v) => v.round)).toEqual([1, 2]);
    expect(calls.arm).toBe(1); // 第一轮没过，没挂
  });

  it('会话没跑成（模型对不上）：按失败分流换一条路由再来，不在原路硬重', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      segment: async (_i, n) =>
        n === 1
          ? {
              ok: false,
              runId: 'r',
              outcome: 'failed',
              evidence: { code: 'model_mismatch', message: '回话的不是点名的模型', quotaExhausted: false },
            }
          : OK_SEGMENT,
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment.map((s) => s.route.routeId)).toEqual(['r1', 'r2']);
    // 动手轮数没多算：换路由不是返工
    expect(run.rounds).toBe(1);
  });

  it('PR 已经被 GitHub 自己合了（CI 等到的是 merged）：不再验收、不再挂，直接关单', async () => {
    const world = createFakeWorld({ ci: () => ({ state: 'merged', mergeCommit: 'deadbeef00' }) });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.verify).toEqual([]);
    expect(calls.arm).toBe(0);
    expect(world.callsOf('closeIssue')[0]?.input).toMatchObject({
      comment: expect.stringContaining('deadbee'),
    });
  });
});

describe('任务工作流 · 停下等人', { timeout: 60_000 }, () => {
  it('交代不全：报警、停下，补齐后点「继续」从头再读', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      brief: (n) =>
        n === 1
          ? { ok: false, problems: [{ field: '场景', why: '正文里没有「## 场景」一节' }] }
          : { ok: true, brief: goodBrief() },
    });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const s = await statusUntil(h, parked, '交代不全，停下等人');
        expect(s.waiting?.detail).toContain('交代不全');
        expect(s.phase).toBe('parked');
        expect(calls.segment).toEqual([]); // 没动手
        await h.signal(taskContinueSignal, { by: 'frank', note: '补好了' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.brief).toBe(2);
    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]).toMatchObject({ level: 'stuck', title: expect.stringContaining('交代不全') });
    expect(world.alerts[0]?.detail).toContain('【场景】');
  });

  it('验收做不出来（没有别家的模型）：停下，不让写代码的会话白改一轮；继续之后重验，没验成的那次不算一轮', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      verify: (_i, n) =>
        n === 1
          ? { pass: false, problems: ['没讨论成'], unavailable: '剩下的家族都挑不出可用模型', round: 1 }
          : { pass: true, problems: [], round: 1 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '验收做不出来，停下');
        expect(s.waiting?.detail).toContain('验收做不出来');
        expect(calls.segment).toHaveLength(1); // 没有返工
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.verify.map((v) => v.round)).toEqual([1, 1]); // 两次都是第 1 轮
  });

  it('改到了标准路径：不挂自动合并，停下等创始人；点「继续」才挂', async () => {
    const world = createFakeWorld();
    let released = false;
    const { tasks, calls } = scripted({
      guarded: () =>
        released ? { standards: [], highRisk: [] } : { standards: ['AGENTS.md'], highRisk: [] },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '改标准，停下等创始人');
        expect(s.waiting?.detail).toContain('标准路径');
        expect(calls.arm).toBe(0);
        released = true;
        await h.signal(taskContinueSignal, { by: 'frank', note: '同意' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.arm).toBe(1);
    expect(world.alerts[0]?.title).toContain('人闸：改标准');
  });

  it('碰了先审后合的路径：停下等第二意见；点「继续」后再查一遍', async () => {
    const world = createFakeWorld();
    let released = false;
    const { tasks, calls } = scripted({
      guarded: () =>
        released
          ? { standards: [], highRisk: [] }
          : { standards: [], highRisk: ['.github/workflows/ci.yml'] },
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(h, parked, '先审后合，停下');
        expect(calls.arm).toBe(0);
        released = true;
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result();
      },
      { tasks },
    );
    expect(calls.guarded).toBe(2);
    expect(calls.arm).toBe(1);
  });

  it('CI 连着红 3 轮：动手 3 轮不过，停下；点「继续」再给一整轮', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n <= 3 ? { state: 'red', failedChecks: ['test (engine)'] } : undefined),
    });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '动手 3 轮都不过，停下');
        expect(s.waiting?.detail).toContain('动手 3 轮都没过');
        expect(calls.segment).toHaveLength(3);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(4);
  });

  it('等合并时 PR 被关了：停下；重开后点「继续」，重新挂再等', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      merged: (n) => (n === 1 ? { state: 'closed' } : { state: 'merged', mergeCommit: 'cafe0000' }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, 'PR 被关了，停下');
        expect(s.waiting?.detail).toContain('被关');
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.arm).toBe(2);
  });

  it('等合并要多轮：waiting 就接着等，不当成失败', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      merged: (n) =>
        n < 3 ? { state: 'waiting', detail: '合并闸还没绿' } : { state: 'merged', mergeCommit: 'beef0000' },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.merged).toBe(3);
    expect(calls.arm).toBe(1);
  });
});

describe('任务工作流 · 放弃', { timeout: 60_000 }, () => {
  it('停着等人时点「放弃」：工作树存档后收，状态记成已叫停，结局是 abandoned', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted({
      brief: () => ({ ok: false, problems: [{ field: '原话', why: '缺' }] }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(h, parked, '停下等人');
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '这张单不做了' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'abandoned', prNumber: null });
    expect(world.states.at(-1)).toMatchObject({ state: 'stopped' });
  });

  it('会话在跑时点「放弃」：取消送进会话，工作流收尾退出（存档收树）', async () => {
    const world = createFakeWorld();
    let cancelled = false;
    const { tasks } = scripted({
      segment: (_i, _n, signal) =>
        new Promise((resolve) => {
          const done = () => {
            cancelled = true;
            resolve({
              ok: false,
              runId: 'r',
              outcome: 'killed',
              evidence: { code: 'aborted', message: '叫停', quotaExhausted: false },
            });
          };
          if (signal.aborted) done();
          signal.addEventListener('abort', done);
        }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitUntil(() => world.count('createWorktree') > 0, '建了工作树');
        await statusUntil(h, (s) => s.doing.includes('动手'), '会话在跑');
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '停掉' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(cancelled).toBe(true);
    expect(world.callsOf('removeWorktree')[0]?.input).toMatchObject({ archive: true });
  });
});

describe('任务工作流 · 【故意造出的失败】不装作做过', { timeout: 60_000 }, () => {
  it('这个引擎工人没装任务活动（假端口）：停下报警，不往下走、不开 PR', async () => {
    const world = createFakeWorld();
    const i = input();
    await withWorker(env, world, async (q) => {
      const h = await start(q, i);
      const s = await statusUntil(h, parked, '没装任务活动，停下');
      expect(s.lastProblem ?? s.waiting?.detail).toBeTruthy();
      expect(world.count('openPr')).toBe(0);
      expect(world.count('createWorktree')).toBe(0);
      expect(world.alerts[0]?.detail).toContain('没装');
      await h.signal(taskAbandonSignal, { by: 'frank', reason: '收工' });
      return h.result();
    });
  });

  it('状态查询：停着时能看出卡在哪一环、在等谁', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted({ brief: () => ({ ok: false, problems: [{ field: '场景', why: '缺' }] }) });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '停下等人');
        expect(s).toMatchObject({
          phase: 'parked',
          prNumber: null,
          waiting: { kind: 'human' },
          lastProblem: expect.stringContaining('交代不全'),
        });
        expect(Date.parse(s.waiting?.since ?? '')).not.toBeNaN();
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '收工' });
        return h.result();
      },
      { tasks },
    );
  });
});

describe('任务工作流 · 交付和合并的细节', { timeout: 60_000 }, () => {
  it('提交了一部分、工作树里还留着没提交的改动：不推，意见写明是哪些文件，下一轮提交完再推', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      delivery: (n) => ({
        head: fakeHead(300 + n),
        commits: 1,
        changedFiles: ['a.ts'],
        leftover: n === 1 ? [' M b.ts', '?? c.ts'] : [],
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.segment[1]?.feedback.join('\n')).toContain('还有没提交的改动');
    expect(calls.segment[1]?.feedback.join('\n')).toContain('?? c.ts');
    expect(world.count('pushBranch')).toBe(1); // 第一轮没推
  });

  it('一个提交都没有、工作树里却有改动：意见两样都说', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      delivery: (n) => ({
        head: fakeHead(400 + n),
        commits: n === 1 ? 0 : 1,
        changedFiles: [],
        leftover: n === 1 ? ['?? new.ts'] : [],
      }),
    });
    await withWorker(env, world, async (q) => (await start(q, input())).result() as Promise<TaskRun>, {
      tasks,
    });
    const text = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(text).toContain('没有产生新的提交');
    expect(text).toContain('?? new.ts');
  });

  it('挂的时候发现已经满足合并条件、当场合了：不再等，关单评论里带合并提交', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      arm: () => ({ armed: false, merged: true, mergeCommit: 'cafe1234567890' }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.merged).toBe(0);
    expect(world.callsOf('closeIssue')[0]?.input).toMatchObject({
      comment: expect.stringContaining('cafe123'),
    });
  });

  it('等合并时自动合并被撤掉了：回去重新挂，挂上再等', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      merged: (n) => (n === 1 ? { state: 'unarmed' } : { state: 'merged', mergeCommit: 'beef1234567890' }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.arm).toBe(2);
    expect(calls.merged).toBe(2);
    expect(calls.order.slice(-4)).toEqual(['arm', 'merged', 'arm', 'merged']);
  });
});

describe('任务工作流 · 验收的岔路（#632 S2-5b）', { timeout: 60_000 }, () => {
  it('这会儿验不了、过一会儿就行（没空位）：睡一会儿再验，不停下报人、不算一轮；验过了照常往下', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      verify: (_i, n) =>
        n === 1
          ? {
              pass: false,
              problems: [],
              round: 1,
              retry: { wait: 'slot', reason: '这会儿没有能派的验收路由', afterSeconds: 30 },
            }
          : { pass: true, problems: [], round: 1 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, verifyRounds: 1 });
    expect(calls.verify.map((v) => v.round)).toEqual([1, 1]); // 等的那次不算一轮
    expect(calls.segment).toHaveLength(1); // 没有返工
    expect(world.alerts).toEqual([]); // 没有停下报人
    expect(calls.arm).toBe(1);
  });

  it('验收时发现 PR 的头被换了：停下等人看过；点「继续」后对新的头重走 CI 和验收，验收重新数轮', async () => {
    const world = createFakeWorld();
    const moved = fakeHead(999);
    const { tasks, calls } = scripted({
      verify: (_i, n) =>
        n === 1
          ? { pass: false, problems: [], round: 1, headMoved: moved }
          : { pass: true, problems: [], round: 1 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, 'PR 的头被别人改了，停下');
        expect(s.waiting?.detail).toContain('头被别人改了');
        expect(calls.arm).toBe(0);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(world.alerts[0]?.detail).toContain('重跑 CI 和验收'); // 告诉人点「继续」之后会发生什么
    expect(run.outcome).toBe('merged');
    expect(calls.verify).toHaveLength(2);
    expect(calls.verify[1]?.headSha).toBe(moved); // 新的头
    expect(calls.verify[1]?.round).toBe(1);
    expect(world.callsOf('waitCi').map((c) => (c.input as { head: string }).head)).toEqual([
      fakeHead(101),
      moved,
    ]);
  });

  it('等合并时头被换了、人点「继续」：不原样重新挂（新头上没有验收状态，闸不放行），回去重走 CI、验收、查路径、再挂', async () => {
    const world = createFakeWorld();
    const moved = fakeHead(888);
    const { tasks, calls } = scripted({
      merged: (n) =>
        n === 1 ? { state: 'head_moved', head: moved } : { state: 'merged', mergeCommit: 'f00d1234567890' },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, 'PR 的头被别人改了，停下');
        expect(s.waiting?.detail).toContain('头被别人改了');
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, verifyRounds: 1, head: moved });
    expect(calls.order.slice(-8)).toEqual([
      'verify',
      'guarded',
      'arm',
      'merged',
      'verify',
      'guarded',
      'arm',
      'merged',
    ]);
    expect(calls.verify[1]?.headSha).toBe(moved);
  });

  it('挂自动合并时发现头已经不是验过的那个：同样回去对新的头重走，不在「自动合并没挂上」里原地打转', async () => {
    const world = createFakeWorld();
    const moved = fakeHead(777);
    const { tasks, calls } = scripted({
      arm: (n) =>
        n === 1
          ? { armed: false, merged: false, why: 'PR 的头变了', headMoved: moved }
          : { armed: true, merged: false },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(h, parked, 'PR 的头被别人改了，停下');
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.verify.map((v) => v.headSha)).toEqual([fakeHead(101), moved]);
    expect(calls.arm).toBe(2);
  });

  it('【故意造出的失败】验收没过：返工意见带进下一轮动手，不是 unavailable 那条停下报人的路', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      verify: (_i, n) =>
        n === 1
          ? { pass: false, problems: ['没做到验收条：页面上没有「验收中」'], round: 1 }
          : { pass: true, problems: [], round: 2 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.segment[1]?.feedback.join('\n')).toContain('验收没过：没做到验收条');
    expect(world.alerts).toEqual([]);
  });
});

describe('任务工作流 · 切号停下动手那一段（org_switch，#59）', { timeout: 60_000 }, () => {
  const CAR: RouteChoice = {
    routeId: 'car',
    poolId: 'claude-carpool',
    modelId: 'm1',
    family: 'claude',
    hostId: 'claude-code',
    orgKind: 'carpool',
  };
  const SOLO: RouteChoice = { ...CAR, routeId: 'solo', poolId: 'claude-solo', orgKind: 'solo' };
  const STOPPED = '切号：会话用户从拼车组织切到独享组织，先停下，切完接着干（会话被停下）';
  const BACK = '切号：会话用户从独享组织切回拼车组织，先停下，切完接着干（会话被停下）';
  const switched = (message: string): RunSegmentResult => ({
    ok: false,
    runId: 'run-x',
    outcome: 'org_switch',
    evidence: { code: 'org_switch', message, quotaExhausted: false },
  });
  /** 真选路的样子：粘着的路由只差一次切号时照常选，落到切过去的那个池上；routes 是每次选中的（用完停在最后一个）。 */
  const switching = (routes: RouteChoice[], picks: PickRouteInput[]) =>
    createFakeWorld({
      route: (i) => {
        picks.push(i);
        const route = routes[Math.min(picks.length, routes.length) - 1] as RouteChoice;
        return { ok: true, route, why: '测试' };
      },
    });

  it('停下之后：不报人、不报警、不换模型，切完选到切过去的池，在同一个分支、同一棵树、同一个基点上重跑，提示里带被停下的原因；轮数不多算', async () => {
    const picks: PickRouteInput[] = [];
    const world = switching([CAR, SOLO], picks);
    const { tasks, calls } = scripted({
      segment: async (_i, n) => (n === 1 ? switched(STOPPED) : OK_SEGMENT),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment.map((s) => s.route.routeId)).toEqual(['car', 'solo']);
    const [first, second] = calls.segment;
    expect(second?.branch).toBe(first?.branch);
    expect(second?.worktreePath).toBe(first?.worktreePath);
    expect(second?.baseSha).toBe(first?.baseSha);
    expect(first?.interrupted).toBeUndefined();
    expect(second?.interrupted).toBe(STOPPED);
    // 原路再试（不换路由、不避开谁）：带着粘着的路由去选，选路判出它只差一次切号，照常选
    expect(picks[1]).toMatchObject({
      stickRouteId: 'car',
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
    });
    expect(world.alerts).toEqual([]);
    // 树只建了一次（重跑不新开分支）
    expect(world.count('createWorktree')).toBe(1);
  });

  it('连着切两回（切过去、又切回来）：两回都接着干，不凑成「同因连挂」停下；提示里带最近一回的原因', async () => {
    const picks: PickRouteInput[] = [];
    const world = switching([CAR, SOLO, CAR], picks);
    const { tasks, calls } = scripted({
      segment: async (_i, n) => (n === 1 ? switched(STOPPED) : n === 2 ? switched(BACK) : OK_SEGMENT),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment.map((s) => s.route.routeId)).toEqual(['car', 'solo', 'car']);
    expect(calls.segment.map((s) => s.interrupted)).toEqual([undefined, STOPPED, BACK]);
    expect(world.alerts).toEqual([]);
  });

  it('【故意造出的失败】切过去重跑又被拒（独享也用满）：按额度用满走（回去选路等），不当切号、不停下；提示里一直带着被停下那回的原因', async () => {
    const picks: PickRouteInput[] = [];
    const world = switching([CAR, SOLO, SOLO], picks);
    const { tasks, calls } = scripted({
      segment: async (_i, n) =>
        n === 1
          ? switched(STOPPED)
          : n === 2
            ? {
                ok: false,
                runId: 'run-y',
                outcome: 'failed',
                evidence: {
                  code: 'quota_exhausted',
                  message: '独享组织的 5 小时额度也用满了',
                  quotaExhausted: true,
                },
              }
            : OK_SEGMENT,
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment.map((s) => s.route.routeId)).toEqual(['car', 'solo', 'solo']);
    // 额度用满（QT1 的组织梯子）：马上回去选路、粘着这条路由等，不避开
    expect(picks[2]).toMatchObject({ stickRouteId: 'solo', avoidRouteIds: [] });
    expect(calls.segment[2]?.interrupted).toBe(STOPPED);
    expect(world.alerts).toEqual([]);
  });

  it('切号前后同一个失败原文：切号不当「上一次」，照样认出「和上一次一字不差」、不在原路硬重（换路由）', async () => {
    const picks: PickRouteInput[] = [];
    const world = switching([CAR, CAR, SOLO, CAR], picks);
    const WEIRD: RunSegmentResult = {
      ok: false,
      runId: 'run-z',
      outcome: 'failed',
      evidence: { code: 'weird_thing', message: '执行体报了一句认不出的话', quotaExhausted: false },
    };
    const { tasks, calls } = scripted({
      segment: async (_i, n) => (n === 1 || n === 3 ? WEIRD : n === 2 ? switched(STOPPED) : OK_SEGMENT),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(4);
    // 第 3 回（切过去之后）又是同一句：不再原路重试，换路由——避开第 3 回跑的那条
    expect(picks[3]?.stickRouteId).toBeUndefined();
    expect(picks[3]?.avoidRouteIds).toEqual(['solo']);
  });
});
