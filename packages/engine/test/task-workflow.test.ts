// 任务工作流（workflows/task.ts，#632 S2-4）：真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。
// 走通的：一张单从动手到合并、关单；返工（没提交、CI 红、验收没过）；换路由；停下等人（交代不全、验收做不出来、改标准、
// 动手几轮都不过、PR 被关）；放弃（停着时、会话跑着时）。故意造的失败：没装任务活动（不许装作做过）。

import { randomUUID } from 'node:crypto';
import type { RouteProbeTarget } from '@fleet-dao/db';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EngineTasks } from '../src/activities.ts';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, FAKE_ROUTES, fakeHead } from '../src/fakes.ts';
import type { RouteProbeJobDeps } from '../src/jobs/route-probe.ts';
import type { PickRouteInput, RouteChoice } from '../src/ports.ts';
import { localExec } from '../src/real/exec.ts';
import { createTaskActivities, type TaskActivitiesDeps } from '../src/real/task-activities.ts';
import {
  type CheckGuardedInput,
  MAX_IMPLEMENT_ROUNDS,
  MAX_VERIFY_ROUNDS,
  type RunSegmentResult,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskContinueSignal,
  taskPauseSignal,
  taskRepinSignal,
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
      feedback: ['派前探测：m1 通'],
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
    // 换阶段要落库：库里的 phase 跟着走，不停在开头的「brief 读单子和需求文档」（#1150 过夜那次驾驶舱和巡查看着像卡在对题）
    const phases = world.states.map((s) => s.phase);
    expect(phases).toEqual(expect.arrayContaining(['implement', 'ci', 'verify', 'merge', 'done']));
    expect(phases.indexOf('implement')).toBeLessThan(phases.indexOf('ci'));
    expect(phases.indexOf('ci')).toBeLessThan(phases.indexOf('verify'));
    expect(phases.indexOf('verify')).toBeLessThan(phases.indexOf('merge'));
    expect(world.states.slice(0, -1).every((s) => s.state === 'running')).toBe(true);
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
    expect(calls.segment[0]?.feedback).toEqual(['派前探测：m1 通']);
    expect(calls.segment[1]?.feedback.join('\n')).toContain('test (engine)');
    expect(calls.segment[1]?.feedback.join('\n')).toContain('FAIL task.test.ts');
    expect(world.count('openPr')).toBe(1);
    expect(world.count('pushBranch')).toBe(2);
    // 第二轮的交付检查从上一轮推上去的头起算，不是从最初的起点
    expect(calls.segment[1]?.baseSha).not.toBe(calls.segment[0]?.baseSha);
    // runs 记账（#216）：第一轮动手时还没开 PR，不带 PR 号（不拿 0 顶）；第二轮带上第一轮开的那个
    expect(calls.segment[0]).not.toHaveProperty('prNumber');
    expect(calls.segment[1]?.prNumber).toBe(run.prNumber);
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

  it('会话没跑成（模型对不上，是路由配置的事）：停下报警等人，不再自动换路由；点「继续」后再来一次', async () => {
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
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '模型对不上，停下等人');
        expect(s.waiting?.detail).toContain('回话的模型不是点名的那个');
        expect(s.lastProblem).toContain('回话的模型不是点名的那个');
        expect(calls.segment).toHaveLength(1); // 没有自动换路由再来
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(2);
    expect(world.alerts[0]).toMatchObject({
      level: 'stuck',
      title: expect.stringContaining('回话的模型不是点名的那个'),
    });
    // 动手轮数没多算：停下等人不是返工
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

  // 查路径用真活动（real/task-activities.ts）+ 内存假 GitHub：不靠桩「点了继续就变空」，
  // 人批了之后能不能放行，由真活动怎么判说了算（#10）。
  const STANDARDS = JSON.stringify({ paths: [{ path: 'AGENTS.md', section: '通用段', why: '通用段' }] });
  function realGuard(prFiles: string[]): {
    checkGuarded: NonNullable<EngineTasks['checkGuarded']>;
    seen: CheckGuardedInput[];
  } {
    const seen: CheckGuardedInput[] = [];
    const acts = createTaskActivities({
      gh: {
        pullFiles: async () => prFiles.map((filename) => ({ filename, status: 'modified' })),
        readRepoFile: async () => ({
          defaultBranch: 'main',
          commit: 'a'.repeat(40),
          file: { kind: 'text', text: STANDARDS },
        }),
      } as unknown as TaskActivitiesDeps['gh'],
      trees: { ownerOf: async () => null },
      exec: localExec(),
    });
    return {
      seen,
      checkGuarded: async (i, ctx) => {
        seen.push(i);
        return acts.checkGuarded(i, ctx);
      },
    };
  }

  it('改到了标准路径：不挂自动合并，停下等创始人；点「继续」后再查放行、才挂（真活动判）', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted();
    const guard = realGuard(['AGENTS.md', 'src/a.ts']);
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '改标准，停下等创始人');
        expect(s.waiting?.detail).toContain('标准路径');
        expect(calls.arm).toBe(0);
        await h.signal(taskContinueSignal, { by: 'frank', note: '同意' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks: { ...tasks, checkGuarded: guard.checkGuarded } },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.arm).toBe(1);
    expect(world.alerts[0]?.title).toContain('人闸：改标准');
    // 第一次没带批准；点「继续」后的第二次带着刚才停下来的那一条
    expect(guard.seen).toHaveLength(2);
    expect(guard.seen[0]?.approved).toBeUndefined();
    expect(guard.seen[1]?.approved?.standards).toEqual([
      'AGENTS.md（AGENTS.md，只有「通用段」这一段算标准）',
    ]);
  });

  it('改了 CI 工作流这类路径：不停下，查一次就放行去挂自动合并（先审后合已整层去掉）', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted();
    const guard = realGuard(['.github/workflows/ci.yml']);
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        return h.result();
      },
      { tasks: { ...tasks, checkGuarded: guard.checkGuarded } },
    );
    expect(guard.seen).toHaveLength(1);
    expect(calls.arm).toBe(1);
  });

  it('批准只认批准那一刻的头：等合并时头被换了，回去重走后同一条路径要重新批，没批就不挂', async () => {
    const world = createFakeWorld();
    const moved = fakeHead(666);
    const { tasks, calls } = scripted({
      arm: (n) =>
        n === 1
          ? { armed: false, merged: false, why: 'PR 的头变了', headMoved: moved }
          : { armed: true, merged: false },
    });
    const guard = realGuard(['AGENTS.md']);
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(h, (s) => parked(s) && !!s.waiting?.detail.includes('标准路径'), '改标准，停下');
        await h.signal(taskContinueSignal, { by: 'frank' }); // 批旧头
        await statusUntil(
          h,
          (s) => parked(s) && !!s.waiting?.detail.includes('头被别人改了'),
          '头被换，停下',
        );
        await h.signal(taskContinueSignal, { by: 'frank' });
        // 新头上同一条路径：旧头上的批准不算数，必须再停一次；这时一次也还没挂成
        await statusUntil(h, (s) => parked(s) && !!s.waiting?.detail.includes('标准路径'), '新头上再停下');
        expect(calls.arm).toBe(1);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks: { ...tasks, checkGuarded: guard.checkGuarded } },
    );
    expect(run).toMatchObject({ outcome: 'merged', head: moved });
    expect(calls.arm).toBe(2);
    expect(guard.seen.map((i) => i.approved !== undefined)).toEqual([false, true, false, true]);
  });

  it('CI 连着红 3 轮：动手 3 轮不过，停下；点「继续」先看 PR 现在的 CI，还红就再给一整轮', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n <= 4 ? { state: 'red', failedChecks: ['test (engine)'] } : undefined),
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

  it('动手 3 轮不过停下时 PR 已开、头已记录（CI 台基础设施问题）：点「继续」先等 CI 和验收，不再起动手会话（#1582）', async () => {
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
        expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS);
        expect(world.count('waitCi')).toBe(3);
        expect(calls.verify).toHaveLength(0);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    // 继续之后没有新会话：会话次数还是停下前的 3 次，推分支和开 PR 也没有再来一遍
    expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS);
    expect(world.count('pushBranch')).toBe(MAX_IMPLEMENT_ROUNDS);
    expect(world.count('openPr')).toBe(1);
    // 直接去看 PR 现在的 CI：第 4 次问回 green，然后冷验收，再挂自动合并
    expect(world.count('waitCi')).toBe(4);
    expect(calls.verify).toHaveLength(1);
    expect(calls.order.slice(-4)).toEqual(['verify', 'guarded', 'arm', 'merged']);
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
    const { tasks, calls } = scripted({
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
        // 等到会话真的起来了才放弃：状态里写着「动手」只说明要起了，活动可能还在排队，那时取消它根本不会跑到会话里（cancelled 永远是假）
        await waitUntil(() => calls.segment.length > 0, '会话在跑');
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '停掉' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(cancelled).toBe(true);
    expect(world.callsOf('removeWorktree')[0]?.input).toMatchObject({ archive: true });
  });

  it('放弃的信号在动手那一步落库期间到（还没起会话）：不再起会话，工作流收尾退出（存档收树）', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted();
    // 「动手」那一步的落库卡住，直到信号送出去：信号到时 cancellable 还没开，它只能被记下来（#706 的竞态）
    let atMirror: () => void = () => {};
    const reached = new Promise<void>((r) => {
      atMirror = r;
    });
    let letGo: () => void = () => {};
    const gate = new Promise<void>((r) => {
      letGo = r;
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await reached;
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '停掉' });
        letGo();
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks,
        wrapActivities: (acts) => ({
          ...acts,
          async saveTaskState(snapshot) {
            if (snapshot.doing.includes('动手')) {
              atMirror();
              await gate;
            }
            return acts.saveTaskState(snapshot);
          },
        }),
      },
    );
    expect(run.outcome).toBe('abandoned');
    expect(calls.segment).toHaveLength(0);
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

  it('挂自动合并时直接合被拒、因为落后主线，引擎已把 PR 同步到最新主线：不停下等人，对新头重走 CI、验收、查路径、再挂', async () => {
    const world = createFakeWorld();
    const synced = fakeHead(555);
    const { tasks, calls } = scripted({
      arm: (n) =>
        n === 1
          ? { armed: false, merged: false, why: '落后主线，已同步', headMoved: synced, syncedMain: true }
          : { armed: true, merged: false },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    // 一次都没停下等人：不用点「继续」，结果直接是合了
    expect(run).toMatchObject({ outcome: 'merged', head: synced });
    expect(calls.verify.map((v) => v.headSha)).toEqual([fakeHead(101), synced]);
    expect(calls.arm).toBe(2);
    expect(calls.armInputs.map((i) => i.syncedBehind)).toEqual([undefined, 1]);
    expect(calls.armInputs[1]?.expectedHead).toBe(synced);
    expect(world.alerts).toEqual([]);
  });

  it('【故意造出的失败】主线一直在动：连着同步 3 次后第 4 次照旧停下报人（原因写清），不无限转', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      arm: (n) =>
        n <= 3
          ? {
              armed: false,
              merged: false,
              why: '落后主线，已同步',
              headMoved: fakeHead(600 + n),
              syncedMain: true,
            }
          : n === 4
            ? {
                armed: false,
                merged: false,
                why: '连着 3 次同步主线后仍落后（主线一直在动）：主线比 PR 多 1 个提交',
              }
            : { armed: true, merged: false },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '自动合并没挂上，停下');
        expect(s.lastProblem).toContain('自动合并没挂上');
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.armInputs.map((i) => i.syncedBehind)).toEqual([undefined, 1, 2, 3, 3]);
    expect(calls.verify).toHaveLength(4);
    // 报给人的话里写清原因
    expect(world.alerts.map((a) => a.detail)).toEqual([expect.stringContaining('连着 3 次同步主线后仍落后')]);
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
    // 动手这一段每次选路都要预占池的名额（#757）：选定路由到写下开跑那一行之间，别的单数得到它
    expect(picks.map((p) => p.reserve)).toEqual(picks.map(() => ({ segment: 'manual' })));
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

  it('切号前后同一个失败原文：切号不当「上一次」，照样认出「和上一次一字不差」、不在原路硬重（停下等人）', async () => {
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
      async (q) => {
        const h = await start(q, input());
        // 第 3 回（切过去之后）又是同一句：不再原路重试，停下等人（原来是换路由）
        const s = await statusUntil(h, parked, '同一句原文再犯，停下等人');
        expect(s.lastProblem).toContain('一字不差');
        expect(calls.segment).toHaveLength(3);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(4);
    // 点「继续」之后重新选路：不粘着、也不避开谁（挂起后计数和避开都清零）
    expect(picks[3]?.stickRouteId).toBeUndefined();
    expect(picks[3]?.avoidRouteIds).toEqual([]);
  });
});

describe('任务工作流 · 渠道运行中失败停下报人，不再换同一个模型的下一个渠道', { timeout: 60_000 }, () => {
  const via = (channelId: string): RouteChoice => ({
    routeId: `r-${channelId}`,
    poolId: `p-${channelId}`,
    modelId: 'm1',
    family: 'claude',
    hostId: 'claude-code',
    channelId,
  });
  /** 回话的模型不对：失败分流判停下、算这条路由的账（MD3）。 */
  const REJECTED: RunSegmentResult = {
    ok: false,
    runId: 'run-x',
    outcome: 'failed',
    evidence: { code: 'model_mismatch', message: '回话的不是点名的模型', quotaExhausted: false },
  };
  /** 真选路的样子：按顺序派第一个没被避开的渠道；都用尽就派不出（waitFor none）。 */
  const channelWorld = (channels: string[], picks: PickRouteInput[]) =>
    createFakeWorld({
      route: (i) => {
        picks.push(i);
        const route = channels.map(via).find((r) => !i.avoidRouteIds.includes(r.routeId));
        return route
          ? { ok: true, route, why: '测试' }
          : { ok: false, waitFor: 'none', detail: '这个模型的渠道都用尽了' };
      },
    });

  it('【故意造出的失败】model_mismatch 第一次就停下报人：不派第二个渠道，选路不带 failedChannel，停着时也不接着换', async () => {
    const picks: PickRouteInput[] = [];
    const world = channelWorld(['c1', 'c2', 'c3', 'c4', 'c5'], picks);
    const { tasks, calls } = scripted({ segment: async () => REJECTED });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '模型对不上，停下等人');
        expect(s.lastProblem).toContain('回话的模型不是点名的那个');
        expect(s.lastProblem).not.toContain('换同一个模型');
        expect(calls.segment.map((x) => x.route.channelId)).toEqual(['c1']);
        expect(picks).toHaveLength(1);
        expect(picks[0]?.failedChannel).toBeUndefined();
        expect(world.alerts[0]).toMatchObject({ level: 'stuck' });
        const pickCount = picks.length;
        await new Promise((r) => setTimeout(r, 300));
        expect(picks).toHaveLength(pickCount);
        expect(calls.segment).toHaveLength(1);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        return h.result().catch(() => undefined);
      },
      { tasks },
    );
    expect(calls.segment).toHaveLength(1);
    expect(world.count('createWorktree')).toBe(1);
  });

  it('点「继续」之后从头再选：不避开刚失败的渠道，选路也不带 failedChannel', async () => {
    const picks: PickRouteInput[] = [];
    const world = channelWorld(['c1', 'c2'], picks);
    const { tasks, calls } = scripted({
      segment: async (_i, n) => (n === 1 ? REJECTED : OK_SEGMENT),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(h, parked, '模型对不上，停下等人');
        expect(calls.segment.map((x) => x.route.channelId)).toEqual(['c1']);
        expect(picks.every((p) => p.failedChannel === undefined)).toBe(true);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment.map((x) => x.route.channelId)).toEqual(['c1', 'c1']);
    expect(picks[1]?.failedChannel).toBeUndefined();
    expect(picks[1]?.avoidRouteIds).toEqual([]);
    expect(picks[1]?.stickRouteId).toBeUndefined();
    expect(world.count('createWorktree')).toBe(1);
  });
});

describe('任务工作流 · 单任务暂停与继续（#820 片 3）', { timeout: 60_000 }, () => {
  const paused = (s: TaskStatus) => s.phase === 'paused';
  /** 第一次会话挂着，直到放行（或收到取消）；之后的会话直接跑成。 */
  const gated = () => {
    const gate = { release: () => {}, aborted: false };
    const open = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const segment = (n: number, signal: AbortSignal): Promise<RunSegmentResult> => {
      if (n !== 1) return Promise.resolve(OK_SEGMENT);
      return new Promise((resolve) => {
        void open.then(() => resolve(OK_SEGMENT));
        const onAbort = () => {
          gate.aborted = true;
          resolve({
            ok: false,
            runId: 'r',
            outcome: 'killed',
            evidence: { code: 'aborted', message: '被取消', quotaExhausted: false },
          });
        };
        if (signal.aborted) onAbort();
        signal.addEventListener('abort', onAbort);
      });
    };
    return { gate, segment };
  };

  it('soft：会话在跑时点暂停，这一段做完就停（不读交付、不起新会话、不报警），库里 phase=paused 而 state 仍是 running；继续后回到原来的阶段接着走，做完', async () => {
    const world = createFakeWorld();
    const { gate, segment } = gated();
    const { tasks, calls } = scripted({ segment: (_i, n, signal) => segment(n, signal) });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitUntil(() => calls.segment.length > 0, '会话在跑');
        await h.signal(taskPauseSignal, { by: 'frank', reason: '先看一下方向', mode: 'soft' });
        gate.release();
        const s = await statusUntil(h, paused, '停进已暂停');
        expect(s.doing).toContain('被人暂停（frank）：先看一下方向');
        expect(s.waiting).toMatchObject({ kind: 'paused' });
        // 停着：这一段做完了，但不往下读交付；没有报警（不是出了问题）
        expect(calls.delivery).toBe(0);
        expect(world.alerts).toEqual([]);
        await waitUntil(() => world.states.at(-1)?.phase === 'paused', '已暂停写进库');
        expect(world.states.at(-1)).toMatchObject({ state: 'running', phase: 'paused' });
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    // 只起过一次会话：暂停和继续没有多起、也没有重跑
    expect(calls.segment).toHaveLength(1);
    // 继续之后回到暂停前的阶段（implement），再往下走；库里 phase 先 paused 后 implement
    const phases = world.states.map((x) => x.phase);
    const at = phases.indexOf('paused');
    expect(at).toBeGreaterThan(-1);
    expect(phases.indexOf('implement', at)).toBeGreaterThan(at);
    expect(world.states.at(-1)).toMatchObject({ state: 'done' });
    expect(world.alerts).toEqual([]);
  });

  it('hard：会话被取消，停进已暂停；继续后在同一个分支、同一棵树上重跑这一段，提示里带「被人暂停」，轮数不多算，不报警', async () => {
    const world = createFakeWorld();
    const { gate, segment } = gated();
    const { tasks, calls } = scripted({ segment: (_i, n, signal) => segment(n, signal) });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitUntil(() => calls.segment.length > 0, '会话在跑');
        await h.signal(taskPauseSignal, { by: 'frank', reason: '跑偏了', mode: 'hard' });
        await statusUntil(h, paused, '停进已暂停');
        // 停着的时候不起新会话
        expect(calls.segment).toHaveLength(1);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    // 取消送进了第一次会话（心跳带过去，工人收工前一定到）
    expect(gate.aborted).toBe(true);
    expect(calls.segment).toHaveLength(2);
    const [first, second] = calls.segment;
    expect(second?.branch).toBe(first?.branch);
    expect(second?.worktreePath).toBe(first?.worktreePath);
    expect(second?.baseSha).toBe(first?.baseSha);
    expect(first?.interrupted).toBeUndefined();
    expect(second?.interrupted).toBe('被人暂停（frank）：跑偏了');
    expect(world.count('createWorktree')).toBe(1);
    expect(world.alerts).toEqual([]);
  });

  it('暂停了别的单照常：一张停着，另一张走完', async () => {
    const world = createFakeWorld();
    const { gate, segment } = gated();
    const { tasks, calls } = scripted({
      segment: (i, n, signal) => (i.issueNumber === 12 ? segment(n, signal) : Promise.resolve(OK_SEGMENT)),
    });
    const other = await withWorker(
      env,
      world,
      async (q) => {
        const a = await start(q, input({ issueNumber: 12 }));
        await waitUntil(() => calls.segment.some((x) => x.issueNumber === 12), 'A 的会话在跑');
        await a.signal(taskPauseSignal, { by: 'frank', mode: 'soft' });
        gate.release();
        await statusUntil(a, paused, 'A 停进已暂停');
        const b = await start(q, input({ issueNumber: 13 }));
        // 不用 result()：等结果时测试服务端会跳时间，没有定时器的 A 会被跳到工作流超时
        // 等库里写进 done，不等 status.phase：finish() 先把 phase 置 done，之后才关单、收树、写库（#1242 偶发红就是断言抢在写库前）
        await waitUntil(
          () => world.states.filter((x) => x.issueNumber === 13).at(-1)?.state === 'done',
          'B 走完（库里写进 done）',
        );
        expect((await statusOf(b)).phase).toBe('done');
        // B 走完时 A 还停着
        expect((await statusOf(a)).phase).toBe('paused');
        expect(world.states.filter((x) => x.issueNumber === 13).at(-1)).toMatchObject({ state: 'done' });
        await a.signal(taskContinueSignal, { by: 'frank' });
        return a.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(other.outcome).toBe('merged');
  });

  it('还没停下（没到检查点）就点继续：撤掉这次暂停，不停下', async () => {
    const world = createFakeWorld();
    const { gate, segment } = gated();
    const { tasks, calls } = scripted({ segment: (_i, n, signal) => segment(n, signal) });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitUntil(() => calls.segment.length > 0, '会话在跑');
        await h.signal(taskPauseSignal, { by: 'frank', mode: 'soft' });
        await h.signal(taskContinueSignal, { by: 'frank' });
        gate.release();
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.states.map((x) => x.phase)).not.toContain('paused');
  });

  it('暂停着点「放弃」：照常收尾（存档收树），结局 abandoned', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        // 信号在第一个检查点之前到：读完交代就停进已暂停
        await h.signal(taskPauseSignal, { by: 'frank' });
        await statusUntil(h, paused, '停进已暂停');
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '不做了' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(world.states.at(-1)).toMatchObject({ state: 'stopped' });
  });

  it('【故意造出的失败】暂停着、没人点继续：不会自己往下走（过了两小时也没有读交付、没有新会话）', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await h.signal(taskPauseSignal, { by: 'frank' });
        await statusUntil(h, paused, '停进已暂停');
        await env.sleep('2 hours');
        expect((await statusOf(h)).phase).toBe('paused');
        expect(calls.segment).toHaveLength(0);
        expect(calls.delivery).toBe(0);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '收工' });
        await h.result();
      },
      { tasks },
    );
  });
});

describe('任务工作流 · 现在就换模型（#1216，taskRepin）', { timeout: 60_000 }, () => {
  const paused = (s: TaskStatus) => s.phase === 'paused';
  /** 第一次会话挂着，直到放行（或收到取消）；之后的会话直接跑成。 */
  const gated = () => {
    const gate = { release: () => {}, aborted: false };
    const open = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const segment = (n: number, signal: AbortSignal): Promise<RunSegmentResult> => {
      if (n !== 1) return Promise.resolve(OK_SEGMENT);
      return new Promise((resolve) => {
        void open.then(() => resolve(OK_SEGMENT));
        const onAbort = () => {
          gate.aborted = true;
          resolve({
            ok: false,
            runId: 'r',
            outcome: 'killed',
            evidence: { code: 'aborted', message: '被取消', quotaExhausted: false },
          });
        };
        if (signal.aborted) onAbort();
        signal.addEventListener('abort', onAbort);
      });
    };
    return { gate, segment };
  };
  const [FIRST, , SECOND] = FAKE_ROUTES;
  if (!FIRST || !SECOND) throw new Error('假路由表要至少三条');
  /** 第一次选路给 r1（m1），之后（人换了模型）给 r3（m2）：模拟选路现读到新指定。 */
  const repinnedRoutes = (n: number) =>
    n === 1
      ? { ok: true as const, route: FIRST, why: '自动' }
      : { ok: true as const, route: SECOND, why: '人指定的' };

  it('动手会话在跑时发 taskRepin：会话被取消，不停下等人、不报警；回选路、新模型在同一分支同一棵树上重跑，提示里写明被人要求现在就换，轮数不多算', async () => {
    const world = createFakeWorld({ route: (_i, n) => repinnedRoutes(n) });
    const { gate, segment } = gated();
    const { tasks, calls } = scripted({ segment: (_i, n, signal) => segment(n, signal) });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitUntil(() => calls.segment.length > 0, '会话在跑');
        await h.signal(taskRepinSignal, { by: 'frank', segment: 'manual', reason: '想试试 Kimi' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(gate.aborted).toBe(true);
    expect(calls.segment).toHaveLength(2);
    const [first, second] = calls.segment;
    // 换了之后下一轮用新模型：第二次选路派到 r3（m2），不是 r1（m1）
    expect(first?.route).toMatchObject({ routeId: 'r1', modelId: 'm1' });
    expect(second?.route).toMatchObject({ routeId: 'r3', modelId: 'm2' });
    expect(world.count('pickRoute')).toBeGreaterThanOrEqual(2);
    // 同一个分支、同一棵树、同一个起点：已做的从分支上接着做
    expect(second?.branch).toBe(first?.branch);
    expect(second?.worktreePath).toBe(first?.worktreePath);
    expect(second?.baseSha).toBe(first?.baseSha);
    expect(first?.interrupted).toBeUndefined();
    expect(second?.interrupted).toBe('被人要求现在就换模型（frank）：想试试 Kimi');
    expect(world.count('createWorktree')).toBe(1);
    // 不是暂停：没有停进已暂停、没有报警
    expect(world.states.map((x) => x.phase)).not.toContain('paused');
    expect(world.alerts).toEqual([]);
  });

  it('换的时候重新选路不粘上一条路由、不带避开：不会因为旧路由粘着或旧的避开把新指定的模型派不出', async () => {
    const picks: PickRouteInput[] = [];
    const world = createFakeWorld({
      route: (i, n) => {
        picks.push(i);
        return repinnedRoutes(n);
      },
    });
    const { segment } = gated();
    const { tasks, calls } = scripted({ segment: (_i, n, signal) => segment(n, signal) });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitUntil(() => calls.segment.length > 0, '会话在跑');
        await h.signal(taskRepinSignal, { by: 'frank', segment: 'manual' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(picks.length).toBeGreaterThanOrEqual(2);
    expect(picks[1]).toMatchObject({ avoidRouteIds: [], avoidPoolIds: [], avoidModelIds: [] });
    expect(picks[1]?.stickRouteId).toBeUndefined();
  });

  it('【故意造出的失败】没有在跑的动手会话（停在暂停里）发 taskRepin：不理它，不起新会话、不取消什么；继续后照常做完，只起一次会话', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await h.signal(taskPauseSignal, { by: 'frank' });
        await statusUntil(h, paused, '停进已暂停');
        await h.signal(taskRepinSignal, { by: 'frank', segment: 'manual' });
        // 查询和信号走同一条任务通道：查得到，说明前面的信号已被工作流处理过
        expect((await statusOf(h)).phase).toBe('paused');
        expect(calls.segment).toHaveLength(0);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(1);
    expect(calls.segment[0]?.interrupted).toBeUndefined();
  });
});

const HANDOFF = '已继续 3 次仍没过，交指挥官';

function briefSaying(request: string, acceptance: string[]) {
  return { ok: true as const, brief: { ...goodBrief(), request, acceptance } };
}

/** 验收连着没过，直到停下。返回那次停下的通知正文。 */
async function verifyStopDetail(env: TestWorkflowEnvironment, problem: string): Promise<string> {
  const world = createFakeWorld();
  const { tasks } = scripted({
    verify: () => ({ pass: false, problems: [problem], round: 1 }),
  });
  await withWorker(
    env,
    world,
    async (q) => {
      const h = await start(q, input());
      await statusUntil(
        h,
        (s) => parked(s) && (s.waiting?.detail.includes('验收 2 轮都没过') ?? false),
        '验收停下',
      );
      await h.signal(taskAbandonSignal, { by: 'frank', reason: '看完原因' });
      return h.result();
    },
    { tasks },
  );
  return world.alerts.find((alert) => alert.title.includes('验收'))?.detail ?? '';
}

describe('任务工作流 · 继续后轮数清零、验收停下写明原因（#1404）', { timeout: 60_000 }, () => {
  it('点「继续」后动手和验收轮数从 0 再计，并真的再跑一轮；下一次验收读的是最新正文', async () => {
    expect(MAX_IMPLEMENT_ROUNDS).toBe(3);
    expect(MAX_VERIFY_ROUNDS).toBe(2);
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      brief: (n) => (n === 1 ? briefSaying('旧正文', ['旧验收条']) : briefSaying('新正文', ['新验收条'])),
      verify: (_input, n) =>
        n === 4
          ? { pass: true, problems: [], round: 2 }
          : { pass: false, problems: ['还没做完'], round: n === 1 ? 1 : 2 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(
          h,
          (s) => parked(s) && (s.waiting?.detail.includes('验收 2 轮都没过') ?? false),
          '验收 2 轮用尽，停下',
        );
        expect(calls.segment).toHaveLength(3);
        expect(calls.verify).toHaveLength(2);
        expect(calls.verify.every((item) => item.what === '旧正文')).toBe(true);
        await h.signal(taskContinueSignal, { by: 'frank' });
        await waitUntil(
          () =>
            calls.segment.length > 3 || world.alerts.some((alert) => alert.title.includes('动手 3 轮都没过')),
          '继续后要么再动手一轮，要么错误地立刻报动手用尽',
        );
        expect(world.alerts.some((alert) => alert.title.includes('动手 3 轮都没过'))).toBe(false);
        expect(calls.verify[2]).toMatchObject({ what: '新正文', howToFinish: ['新验收条'], round: 1 });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.brief).toBe(2);
    expect(calls.segment).toHaveLength(4);
    expect(calls.segment[3]?.brief).toMatchObject({ request: '新正文', acceptance: ['新验收条'] });
    expect(calls.verify.map((item) => item.round)).toEqual([1, 2, 1, 2]);
    expect(
      calls.verify.slice(2).every((item) => item.what === '新正文' && item.howToFinish[0] === '新验收条'),
    ).toBe(true);
  });

  it('同一次继续里动手仍停在上限；累计继续超过 3 次不再清零，停下并写明交指挥官', async () => {
    const world = createFakeWorld({
      ci: () => ({ state: 'red', failedChecks: ['test (engine)'] }),
    });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(
          h,
          (s) => parked(s) && (s.waiting?.detail.includes('动手 3 轮都没过') ?? false),
          '动手 3 轮用尽',
        );
        expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS);
        for (let time = 0; time < 3; time += 1) {
          const before = calls.segment.length;
          await h.signal(taskContinueSignal, { by: 'frank' });
          await waitUntil(
            () => calls.segment.length >= before + MAX_IMPLEMENT_ROUNDS,
            `第 ${time + 1} 次继续后再动手到上限`,
          );
          await statusUntil(
            h,
            (s) => parked(s) && (s.waiting?.detail.includes('动手 3 轮都没过') ?? false),
            `第 ${time + 1} 次继续用尽后再停下`,
          );
          expect(calls.segment).toHaveLength(before + MAX_IMPLEMENT_ROUNDS);
        }
        expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS * 4);
        await h.signal(taskContinueSignal, { by: 'frank' });
        await waitUntil(
          () =>
            calls.segment.length > MAX_IMPLEMENT_ROUNDS * 4 ||
            world.alerts.some((alert) => alert.detail.includes(HANDOFF)),
          '第 4 次继续要么停住交指挥官，要么又动手',
        );
        expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS * 4);
        const stopped = await statusUntil(
          h,
          (s) => parked(s) && (s.waiting?.detail.includes(HANDOFF) ?? false),
          '已继续 3 次仍没过',
        );
        expect(stopped.waiting?.detail).toContain(HANDOFF);
        expect(world.alerts.at(-1)?.title).toBe(HANDOFF);
        expect(world.alerts.at(-1)?.detail).toContain(HANDOFF);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '交指挥官' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS * 4);
  });

  it('验收停下：原话含「无法证明」时，通知第一行是「验收条在 diff 里证不了」，后面接着原话', async () => {
    const problem = '无法证明：diff 未包含验收条要的状态，也无法确认';
    const detail = await verifyStopDetail(env, problem);
    expect(detail.split('\n')[0]).toBe('验收条在 diff 里证不了');
    expect(detail).toContain(problem);
  });

  it('验收停下：原话含「额外修改」时，通知第一行是「PR 改了范围外的文件」，后面接着原话', async () => {
    const problem = '有额外修改，动了范围外的 packages/other.ts';
    const detail = await verifyStopDetail(env, problem);
    expect(detail.split('\n')[0]).toBe('PR 改了范围外的文件');
    expect(detail).toContain(problem);
  });

  it('【故意造出的失败】验收原话对不上两类时归「其它」，原文留在通知里不被吞掉', async () => {
    const problem = '按钮颜色改深了，看不出和验收条的关系';
    const detail = await verifyStopDetail(env, problem);
    expect(detail.split('\n')[0]).toBe('其它');
    expect(detail.split('\n').slice(1).join('\n')).toContain(problem);
  });
});

const PROBE_ROUTES: RouteChoice[] = [
  {
    routeId: 'a',
    poolId: 'p1',
    modelId: 'glm-5.3-flash',
    family: 'claude',
    hostId: 'claude-code',
    reservationId: 'res-a',
  },
  {
    routeId: 'b',
    poolId: 'p2',
    modelId: 'deepseek-flash',
    family: 'claude',
    hostId: 'claude-code',
    reservationId: 'res-b',
  },
  {
    routeId: 'c',
    poolId: 'p3',
    modelId: 'kimi',
    family: 'kimi',
    hostId: 'api-shell',
    reservationId: 'res-c',
  },
];

function probeTarget(route: RouteChoice): RouteProbeTarget {
  return {
    routeId: route.routeId,
    hostId: route.hostId,
    channelId: 'ch',
    channelName: '渠道',
    billing: 'subscription',
    channelEnabled: true,
    identityCheck: false,
    poolId: route.poolId,
    runAsUser: null,
    orgKind: null,
    modelId: route.modelId,
    modelName: route.modelId,
    upstreamModel: route.modelId,
    modelRetiredAt: null,
    inUse: true,
    alive: true,
    lastRunAt: null,
    failStreak: 0,
    previous: null,
  };
}

/** 三条候选都当场探不通。attempt 从 1 起；passAfter 之前的路由编号按不通回。 */
function failingProbe(passAfter: string | null): {
  jobs: { routeProbe: () => RouteProbeJobDeps };
  probed: () => string[];
} {
  const probed: string[] = [];
  const deps: RouteProbeJobDeps = {
    targets: async () => PROBE_ROUTES.map(probeTarget),
    probers: {
      'claude-code': async (target) => {
        probed.push(target.routeId);
        if (passAfter !== null && target.routeId === passAfter)
          return { kind: 'answered', detail: '答上了：OK' };
        return { kind: 'failed', detail: `${target.modelId} 网络不通` };
      },
      'api-shell': async (target) => {
        probed.push(target.routeId);
        return { kind: 'failed', detail: `${target.modelId} 网络不通` };
      },
    },
    sessionOrg: async () => ({ ok: true, org: 'carpool' }),
    save: async () => 'saved',
    runs: { start: async () => 1, finish: async () => {} },
    now: () => new Date('2026-10-09T08:00:00.000Z'),
    sleep: async () => {},
    log: () => {},
  };
  return { jobs: { routeProbe: () => deps }, probed: () => probed };
}

describe('任务工作流 · 派前探测（#1409）', { timeout: 60_000 }, () => {
  it('探不通就换下一条，会话的返工意见写明换到谁，并在再选之前放掉没派的那条预占', async () => {
    const world = createFakeWorld({ routes: PROBE_ROUTES });
    const { tasks, calls } = scripted();
    const probe = failingProbe('b');
    const released: { id: string; picks: number }[] = [];
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
        jobs: {
          ...probe.jobs,
          releaseReservation: async (id) => {
            released.push({ id, picks: world.count('pickRoute') });
          },
        },
      },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(1);
    expect(calls.segment[0]?.route.routeId).toBe('b');
    expect(calls.segment[0]?.route.reservationId).toBe('res-b');
    expect(released).toEqual([{ id: 'res-a', picks: 1 }]);
    expect(calls.segment[0]?.feedback.join('\n')).toContain(
      '派前探测：glm-5.3-flash 不通，换到 deepseek-flash',
    );
    expect(
      world.states.some((s) => s.doing.includes('派前探测：glm-5.3-flash 不通，换到 deepseek-flash')),
    ).toBe(true);
    expect(probe.probed()).toContain('a');
  });

  it('三条都探不通：不起会话，停下并写出每条结果，沿用全熔断提醒，三条预占都放掉', async () => {
    const world = createFakeWorld({ routes: PROBE_ROUTES });
    const { tasks, calls } = scripted();
    const probe = failingProbe(null);
    const released: { id: string; picks: number }[] = [];
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(
          h,
          (state) => state.waiting?.kind === 'slot' && state.doing.includes('不起会话'),
          '三条都探不通，停下',
        );
        expect(s.phase).toBe('implement');
        expect(s.doing).toContain('派前探测：glm-5.3-flash 不通（');
        expect(s.doing).toContain('deepseek-flash 不通（');
        expect(s.doing).toContain('kimi 不通（');
        expect(s.doing).toContain('本轮已当场探 3 条，不再往下探');
        expect(s.doing).toContain('不起会话，等探针探通后再继续');
        expect(s.lastProblem).toBe(s.doing);
        expect(calls.segment).toEqual([]);
        expect(released).toEqual([
          { id: 'res-a', picks: 1 },
          { id: 'res-b', picks: 2 },
          { id: 'res-c', picks: 3 },
        ]);
        expect(world.alerts).toContainEqual(
          expect.objectContaining({
            dedupeKey: 'routing:all-open:ui',
            title: '「ui」阶段的路由全都熔断了',
            detail: s.doing,
          }),
        );
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks,
        jobs: {
          ...probe.jobs,
          releaseReservation: async (id) => {
            released.push({ id, picks: world.count('pickRoute') });
          },
        },
      },
    );
  });

  it('候选一开始就全被挡住、还没探过：不起会话，停下通知列出每条原因，并沿用全熔断提醒', async () => {
    const blocked =
      'ui阶段没有能派的路由（第 1 条 glm-5.3-flash：不在线（探活或熔断判的）；第 2 条 deepseek-flash：不在线（探活或熔断判的））';
    const world = createFakeWorld({
      route: () => ({ ok: false, waitFor: 'none', detail: blocked }),
    });
    const { tasks, calls } = scripted();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(
          h,
          (state) => state.waiting?.kind === 'slot' && state.doing.includes('派前探测：'),
          '候选都被挡住，派前探测停下',
        );
        expect(s.phase).toBe('implement');
        expect(s.doing).toContain('glm-5.3-flash');
        expect(s.doing).toContain('不在线（探活或熔断判的）');
        expect(s.doing).toContain('deepseek-flash');
        expect(s.doing).toContain('不起会话，等探针探通后再继续');
        expect(s.lastProblem).toBe(s.doing);
        expect(s.waiting?.kind).not.toBe('human');
        expect(calls.segment).toEqual([]);
        expect(world.alerts).toContainEqual(
          expect.objectContaining({
            dedupeKey: 'routing:all-open:ui',
            title: '「ui」阶段的路由全都熔断了',
            detail: s.doing,
          }),
        );
        expect(world.alerts.some((alert) => alert.title === '没有可用的路由')).toBe(false);
        expect(world.states.some((state) => state.doing === s.doing && state.lastProblem === s.doing)).toBe(
          true,
        );
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
  });
});

/** 读交付：前 zeroUntil 次没有提交，其后有。 */
function deliveryAfterMisses(zeroUntil: number) {
  return (n: number) => ({
    head: fakeHead(300 + n),
    commits: n <= zeroUntil ? 0 : 1,
    changedFiles: n <= zeroUntil ? [] : ['a.ts'],
  });
}

function routePicks(world: ReturnType<typeof createFakeWorld>, taskId?: string): PickRouteInput[] {
  return world
    .callsOf('pickRoute')
    .map((call) => call.input)
    .filter((pick) => taskId === undefined || pick.taskId === taskId);
}

describe('任务工作流 · 没提交就避开上一轮路由（#1408）', { timeout: 60_000 }, () => {
  it('第 1 轮没有提交：第 2 轮选路避开那条路由，不避开模型；下一张单不受影响', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({ delivery: deliveryAfterMisses(1) });
    const first = input();
    const second = input({ issueNumber: 34 });
    await withWorker(
      env,
      world,
      async (q) => {
        const run = (await start(q, first)).result() as Promise<TaskRun>;
        expect(await run).toMatchObject({ outcome: 'merged', rounds: 2 });
        return (await start(q, second)).result() as Promise<TaskRun>;
      },
      { tasks },
    );
    const firstPicks = routePicks(world, first.taskId);
    expect(firstPicks[0]?.avoidRouteIds).toEqual([]);
    expect(firstPicks[0]?.avoidModelIds).toEqual([]);
    expect(firstPicks[1]?.avoidRouteIds).toEqual(['r1']);
    expect(firstPicks[1]?.avoidModelIds).toEqual([]);
    expect(firstPicks[1]?.avoidPoolIds).toEqual([]);
    const again = calls.segment.filter((segment) => segment.taskId === first.taskId);
    expect(again[1]?.route.routeId).toBe('r2');
    const opinion = again[1]?.feedback.join('\n') ?? '';
    expect(opinion).toContain('没有产生新的提交');
    expect(opinion).toContain('上一轮用的是路由 r1');
    expect(opinion).toContain('这一轮避开它');
    expect(opinion).not.toContain('也避开模型');
    const secondPicks = routePicks(world, second.taskId);
    expect(secondPicks.length).toBeGreaterThan(0);
    expect(
      secondPicks.every((pick) => pick.avoidRouteIds.length === 0 && pick.avoidModelIds.length === 0),
    ).toBe(true);
  });

  it('连着两轮没有提交：下一轮选路避开路由，也避开那个模型', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({ delivery: deliveryAfterMisses(2) });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 3 });
    const picks = routePicks(world);
    expect(picks[1]?.avoidRouteIds).toEqual(['r1']);
    expect(picks[1]?.avoidModelIds).toEqual([]);
    expect(picks[2]?.avoidRouteIds).toEqual(['r1', 'r2']);
    expect(picks[2]?.avoidModelIds).toEqual(['m1']);
    expect(calls.segment[2]?.route).toMatchObject({ routeId: 'r3', modelId: 'm2' });
    const opinion = calls.segment[2]?.feedback.join('\n') ?? '';
    expect(opinion).toContain('上一轮用的是路由 r2');
    expect(opinion).toContain('这一轮避开它');
    expect(opinion).toContain('也避开模型 m1');
  });

  it('避开之后没有别的路由：仍派原来的路由，lastProblem 写明没有别的路由可换', async () => {
    const only = FAKE_ROUTES[0];
    if (!only) throw new Error('假路由应该有第一条');
    const world = createFakeWorld({ routes: [only] });
    const { tasks, calls } = scripted({ delivery: deliveryAfterMisses(1) });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(routePicks(world).some((pick) => pick.avoidRouteIds.includes('r1'))).toBe(true);
    expect(calls.segment[1]?.route.routeId).toBe('r1');
    expect(world.states.some((state) => state.lastProblem?.includes('没有别的路由可换'))).toBe(true);
    expect(world.alerts.some((alert) => alert.title.includes('没有可用的路由'))).toBe(false);
    expect(calls.segment[1]?.feedback.join('\n')).toContain('没有别的路由可换');
  });

  it('有提交的一轮不触发避让：CI 红了再来，选路不带路由避让也不带模型避让', async () => {
    const world = createFakeWorld({
      ci: (_input, n) => (n === 1 ? { state: 'red', failedChecks: ['test (engine)'] } : undefined),
    });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    const picks = routePicks(world);
    expect(picks[1]?.avoidRouteIds).toEqual([]);
    expect(picks[1]?.avoidModelIds).toEqual([]);
    expect(calls.segment[1]?.route.routeId).toBe('r1');
    expect(calls.segment[1]?.feedback.join('\n')).not.toContain('这一轮避开它');
  });

  it('【故意造出的失败】点「继续」后避让必须是空的', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({ delivery: deliveryAfterMisses(3) });
    const task = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, task);
        await statusUntil(
          h,
          (s) => parked(s) && (s.waiting?.detail.includes('动手 3 轮都没过') ?? false),
          '三轮都没提交，停下',
        );
        const before = routePicks(world, task.taskId);
        expect(before.some((pick) => pick.avoidRouteIds.length > 0 || pick.avoidModelIds.length > 0)).toBe(
          true,
        );
        const seen = before.length;
        await h.signal(taskContinueSignal, { by: 'frank' });
        await waitUntil(() => routePicks(world, task.taskId).length > seen, '继续后再选路');
        const next = routePicks(world, task.taskId)[seen];
        expect(next?.avoidRouteIds).toEqual([]);
        expect(next?.avoidModelIds).toEqual([]);
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment.filter((segment) => segment.taskId === task.taskId).length).toBeGreaterThan(3);
  });
});
