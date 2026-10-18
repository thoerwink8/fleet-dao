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
import { type PickRouteInput, PortError, type RouteChoice } from '../src/ports.ts';
import { localExec } from '../src/real/exec.ts';
import { createTaskActivities, type TaskActivitiesDeps } from '../src/real/task-activities.ts';
import {
  ARM_PENDING_CHECKS_MINUTES,
  ARM_PENDING_POLL_SECONDS,
  type ArmAutoMergeInput,
  type ArmAutoMergeResult,
  type CheckGuardedInput,
  MAX_IMPLEMENT_ROUNDS,
  MAX_VERIFY_ROUNDS,
  MERGE_RED_CONFIRM_SECONDS,
  type MergeWait,
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
import { goodBrief, OK_SEGMENT, type Script, scripted } from './task-script.ts';

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
    expect(calls.segment[0]?.feedback).toEqual([]);
    expect(world.states.some((s) => s.doing.includes('派前探测：m1 通'))).toBe(true);
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

  it('第 2 轮验收入参带上轮没过的条和增量起点', async () => {
    const world = createFakeWorld();
    const problem = '没做到验收条：第 1 条：页面上看不到「验收中」';
    const { tasks, calls } = scripted({
      verify: (_i, n) =>
        n === 1 ? { pass: false, problems: [problem], round: 1 } : { pass: true, problems: [], round: 2 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', verifyRounds: 2 });
    expect(calls.verify[0]).not.toHaveProperty('recheck');
    expect(calls.verify[1]?.recheck).toEqual({
      failedCriteria: [1],
      sinceSha: calls.verify[0]?.headSha,
      priorProblems: [problem],
    });
    expect(calls.verify[1]?.headSha).not.toBe(calls.verify[0]?.headSha);
  });

  it('第 2 轮头没变也带上轮复核材料', async () => {
    const world = createFakeWorld();
    const problem = '没做到验收条：第 1 条：页面上看不到「验收中」';
    const { tasks, calls } = scripted({
      delivery: () => ({
        head: fakeHead(777),
        commits: 1,
        changedFiles: ['packages/web/src/pages/a.tsx'],
      }),
      verify: (_i, n) =>
        n === 1 ? { pass: false, problems: [problem], round: 1 } : { pass: true, problems: [], round: 2 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', verifyRounds: 2 });
    expect(calls.verify[1]?.headSha).toBe(calls.verify[0]?.headSha);
    expect(calls.verify[1]?.recheck).toEqual({
      failedCriteria: [1],
      sinceSha: calls.verify[0]?.headSha,
      priorProblems: [problem],
    });
  });

  it('会话没跑成（模型对不上）：先换同一派工档的下一条路由重派一次', async () => {
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
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment.map((x) => x.route.routeId)).toEqual(['r1', 'r2']);
    expect(calls.segment[1]?.tier).toEqual(calls.segment[0]?.tier);
    expect(calls.segment[1]?.resumeSessionId).toBeUndefined();
    expect(world.callsOf('pickRoute')[1]?.input).toMatchObject({
      avoidRouteIds: ['r1'],
      avoidModelIds: [],
    });
    expect(world.alerts).toEqual([]);
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
    // 和等 CI 同时起的那一次验收（决定 0093）可能已经调了，但结果没被认：最多那一次，验收轮数没加
    expect(calls.verify.length).toBeLessThanOrEqual(1);
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

  it('CI 红了 2 轮、第 3 轮验收没过（#1967 卡了 8 小时）：验收意见照样交给一轮动手，不因动手轮数用完就停下等人', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n <= 2 ? { state: 'red', failedChecks: ['check'] } : undefined),
    });
    const { tasks, calls } = scripted({
      // 按头判：CI 红的两轮里和 CI 同时起的验收会被丢掉（决定 0093），不能按第几次调用排答案
      verify: (i) =>
        i.headSha === fakeHead(103)
          ? { pass: false, problems: ['没做到验收条：第 4 条，Mirasim 校验存在绕过入口'], round: 1 }
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
    expect(run).toMatchObject({ outcome: 'merged', verifyRounds: 2 });
    // 第 4 轮动手拿到的是验收的问题表；没停下等人、没报警
    expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS + 1);
    expect(calls.segment.at(-1)?.feedback.join('\n')).toContain('Mirasim 校验存在绕过入口');
    expect(world.alerts).toEqual([]);
  });

  it('【故意造出的失败】验收 2 轮都没过：多给的那一轮只有一次；头一回用尽自动续一次，再用尽就停下等人', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n <= 2 ? { state: 'red', failedChecks: ['check'] } : undefined),
    });
    const { tasks, calls } = scripted({
      verify: () => ({ pass: false, problems: ['没做到验收条：第 6 条'], round: 1 }),
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '验收 2 轮都没过，停下');
        expect(s.lastProblem).toMatch(/验收 2 轮都没过/);
        // 前 4 轮（多给的那一轮在内）用尽动手轮数、自动续一次（决定 0093）；再 3 轮后验收第二回用尽才停下
        expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS + 1 + MAX_IMPLEMENT_ROUNDS);
        expect(world.alerts.filter((a) => a.title.includes('轮都没过'))).toHaveLength(1);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测试收尾' });
        return h.result();
      },
      { tasks },
    );
  });

  it('CI 连着红：动手 3 轮不过先自动续一次，再 3 轮不过才停下；点「继续」先看 PR 现在的 CI，还红就再给一整轮', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n <= 7 ? { state: 'red', failedChecks: ['test (engine)'] } : undefined),
    });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '动手 3 轮都不过，停下');
        expect(s.waiting?.detail).toContain('动手 3 轮都没过');
        expect(calls.segment).toHaveLength(6);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(7);
  });

  it('动手 3 轮不过停下时 PR 已开、头已记录（CI 台基础设施问题）：点「继续」先等 CI 和验收，不再起动手会话（#1582）', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n <= 6 ? { state: 'red', failedChecks: ['test (engine)'] } : undefined),
    });
    const { tasks, calls } = scripted();
    const ROUNDS = MAX_IMPLEMENT_ROUNDS * 2; // 头一回用尽自动续了一次（决定 0093）
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '动手 3 轮都不过，停下');
        expect(s.waiting?.detail).toContain('动手 3 轮都没过');
        expect(calls.segment).toHaveLength(ROUNDS);
        expect(world.count('waitCi')).toBe(ROUNDS);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    // 继续之后没有新会话：会话次数还是停下前的那么多，推分支和开 PR 也没有再来一遍
    expect(calls.segment).toHaveLength(ROUNDS);
    expect(world.count('pushBranch')).toBe(ROUNDS);
    expect(world.count('openPr')).toBe(1);
    // 直接去看 PR 现在的 CI：这一次回 green，然后冷验收（和 CI 同时起），再挂自动合并
    expect(world.count('waitCi')).toBe(ROUNDS + 1);
    expect(calls.order.slice(-3)).toEqual(['guarded', 'arm', 'merged']);
    expect(calls.order.lastIndexOf('verify')).toBeLessThan(calls.order.lastIndexOf('arm'));
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

  const checksRed: MergeWait = {
    state: 'checks_red',
    failedChecks: ['merge-gate'],
    detail: 'merge-gate：cold-verify 没过',
  };

  it('等合并时必过检查转红：确认窗口里写上检查红了，第二次仍红就返工，意见里有检查名和原因（#1983）', async () => {
    expect(MERGE_RED_CONFIRM_SECONDS).toBe(20);
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      merged: (n) => (n <= 2 ? checksRed : { state: 'merged', mergeCommit: 'abc1234567890' }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    const noted = world.states.filter((s) => s.doing.startsWith('检查红了：'));
    expect(noted[0]).toMatchObject({ phase: 'merge', state: 'running', doing: '检查红了：merge-gate' });
    expect(noted[0]?.doing).not.toContain('等合并');
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[0]?.feedback.join('\n')).not.toContain('检查红了');
    const feedback = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(feedback).toContain('检查红了：merge-gate');
    expect(feedback).toContain('cold-verify 没过');
    // 同一轮里看两次才返工：第一次记下，确认后第二次仍红才进下一轮动手
    expect(calls.merged).toBe(3);
  });

  it('等合并时红了一下又变回还在跑：不返工，接着等（#1983）', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      merged: (n) => {
        if (n === 1 || n === 3) return checksRed;
        if (n === 2) return { state: 'waiting', detail: '检查还在跑' };
        return { state: 'merged', mergeCommit: 'abc1234567890' };
      },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(1);
    expect(world.states.some((s) => s.doing === '检查红了：merge-gate')).toBe(true);
    expect(calls.merged).toBe(4);
  });

  it('等合并时检查连着红、返工 3 轮用完：头一回自动续一次，再用完停下，报警进要你拍的，不再等（#1983）', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      merged: () => checksRed,
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        // 每轮红两次之间隔 20 秒确认：让测试服务端把这几段跳过去
        // （查询不解锁跳时，干等会卡在第一次确认上；跳完再查，不 await result()，#1764）
        await env.sleep('10 minutes');
        const s = await statusUntil(h, (st) => parked(st) || calls.merged > 12, '检查红了返工用完要停下');
        expect(parked(s)).toBe(true);
        expect(s.phase).toBe('parked');
        expect(s.waiting?.detail).toContain('检查红了');
        expect(s.doing).toContain('检查红了');
        expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS * 2);
        expect(calls.merged).toBe(MAX_IMPLEMENT_ROUNDS * 2 * 2);
        expect(world.alerts[0]).toMatchObject({
          level: 'decision',
          title: expect.stringMatching(/^检查红了/),
        });
        expect(world.alerts[0]?.detail).toContain('merge-gate');
        expect(world.alerts[0]?.detail).toContain('cold-verify 没过');
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '停' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
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

  it('等合并时 PR 和主线冲突、并主线并得干净（#1838）：不停在等待循环里，回 head_moved 对新头重走 CI 和验收', async () => {
    const world = createFakeWorld({
      // 挂上自动合并、第一次等合并回冲突；并完主线的头是新的
      sync: (_i, n) => (n === 1 ? { state: 'clean', head: fakeHead(700) } : undefined),
    });
    const { tasks, calls } = scripted({
      merged: (n) => (n === 1 ? { state: 'conflict', detail: 'PR #1 和主线冲突' } : { state: 'merged' }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', head: fakeHead(700) });
    // 一次都没停下等人：并主线是引擎自己换的头，直接回去对新头重走
    expect(world.alerts).toEqual([]);
    // 新的头重走了一遍 CI 和验收
    expect(calls.verify.map((v) => v.headSha)).toEqual([fakeHead(101), fakeHead(700)]);
    expect(world.callsOf('waitCi').map((c) => (c.input as { head: string }).head)).toEqual([
      fakeHead(101),
      fakeHead(700),
    ]);
    // 状态里写明了是冲突挡着（#1838：以前只写「在合并队列」，看不出是冲突）
    expect(world.states.some((s) => s.doing.includes('冲突'))).toBe(true);
  });

  it('等合并时 PR 和主线真有冲突、并不动（#1838）：冲突文件名进返工意见，交回下一轮动手会话解', async () => {
    const world = createFakeWorld({
      sync: (_i, n) =>
        n === 1 ? { state: 'conflict', conflictFiles: ['packages/conventions/src/ci-plan.ts'] } : undefined,
    });
    const { tasks, calls } = scripted({
      merged: (n) => (n === 1 ? { state: 'conflict', detail: 'PR #1 和主线冲突' } : { state: 'merged' }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    // 回了动手再跑一轮：返工意见里带着冲突文件名
    expect(calls.segment).toHaveLength(2);
    const feedback = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(feedback).toContain('和最新主线有冲突');
    expect(feedback).toContain('packages/conventions/src/ci-plan.ts');
  });

  it('【故意造出的失败】连着并满 3 次还冲突：停下报人，不无限并（#1838）', async () => {
    const world = createFakeWorld({
      // 每次都「没什么可并」（头不变）、GitHub 却一直说冲突：靠次数上限兜底，不无限并、不一直转
      sync: () => ({ state: 'clean', head: fakeHead(101) }),
    });
    const { tasks } = scripted({ merged: () => ({ state: 'conflict', detail: 'PR #1 和主线冲突' }) });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        // 中间那几次「等 GitHub 把冲突数据重算过来」是 60 秒一跳：让测试服务端把这几段跳过去
        // （不跳的话要按真实时间干等三分钟；跳完再查，不 await result()，#1764）
        await env.sleep('5 minutes');
        const s = await statusUntil(h, parked, '并满 3 次仍冲突，停下');
        expect(s.lastProblem).toContain('还是和主线冲突');
        expect(s.doing).toContain('冲突');
        expect(world.count('syncMainline')).toBe(3); // 并到上限就停，不接着并
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '不做了' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(world.alerts.map((a) => a.title)).toEqual([expect.stringContaining('还是和主线冲突')]);
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

type ProtoDuration = { seconds?: unknown; nanos?: unknown } | null | undefined;

/** 历史里的时长（秒）。没设是 0；认不出就抛，不把空当成 0。 */
function durationSeconds(d: ProtoDuration): number {
  if (d == null) return 0;
  const seconds = Number(d.seconds ?? 0);
  const nanos = Number(d.nanos ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos))
    throw new Error(`认不出时长：${JSON.stringify(d)}`);
  return seconds + nanos / 1e9;
}

/** 历史里每一次调度 armAutoMerge 的期限（秒），按调度先后。 */
function armBudgets(events: readonly unknown[]): { scheduleToClose: number; startToClose: number }[] {
  const out: { scheduleToClose: number; startToClose: number }[] = [];
  for (const e of events as {
    activityTaskScheduledEventAttributes?: {
      activityType?: { name?: string | null } | null;
      scheduleToCloseTimeout?: ProtoDuration;
      startToCloseTimeout?: ProtoDuration;
    } | null;
  }[]) {
    const a = e.activityTaskScheduledEventAttributes;
    if (a?.activityType?.name !== 'armAutoMerge') continue;
    out.push({
      scheduleToClose: durationSeconds(a.scheduleToCloseTimeout),
      startToClose: durationSeconds(a.startToCloseTimeout),
    });
  }
  return out;
}

describe('任务工作流 · 挂合并时检查还在跑（Refs 重跑 merge-gate）', { timeout: 120_000 }, () => {
  const ORIGIN =
    'GitHub 说 PR 已经满足合并条件，直接合被拒（ci_not_green）：PR #3072 的 CI 在 c38530e 上不是全绿（没跑完：merge-gate）';
  const ARMED: ArmAutoMergeResult = { armed: true, merged: false };
  const polls = Math.floor((ARM_PENDING_CHECKS_MINUTES * 60) / ARM_PENDING_POLL_SECONDS);

  /** 精确头上 merge-gate 还在队列里：活动交回的那一包。why 里的「没跑完」不算数，只认 checksPending。 */
  const waitingCheck = (input: ArmAutoMergeInput, names: string[], detail = ORIGIN): ArmAutoMergeResult => ({
    armed: false,
    merged: false,
    why: detail,
    checksPending: { names, head: input.expectedHead, detail },
  });

  /** 原文写没跑完，现读却是真红。工作流必须按红处理，不能拿这句去等。 */
  const redCheck = (input: ArmAutoMergeInput): ArmAutoMergeResult => ({
    armed: false,
    merged: false,
    why: ORIGIN,
    checksRed: {
      failedChecks: ['merge-gate'],
      detail: 'merge-gate：cold-verify 没过',
      head: input.expectedHead,
    },
  });

  it('精确头 CI 已绿、正文更新把 merge-gate 打回队列：等检查，同头绿了自己再挂，不用人点继续', async () => {
    expect(ARM_PENDING_CHECKS_MINUTES).toBe(15);
    expect(ARM_PENDING_POLL_SECONDS).toBe(20);
    const world = createFakeWorld();
    const head = fakeHead(101);
    const { tasks, calls } = scripted({
      arm: (n, input) => (n === 1 ? waitingCheck(input, ['merge-gate']) : ARMED),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, verifyRounds: 1, head });
    const noted = world.states.filter((s) => s.doing === '等检查：merge-gate');
    expect(noted[0]).toMatchObject({
      phase: 'merge',
      state: 'running',
      doing: '等检查：merge-gate',
      lastProblem: '等检查：merge-gate',
    });
    expect(world.states.some((s) => s.state === 'stalled')).toBe(false);
    expect(world.alerts).toEqual([]);
    expect(calls.arm).toBe(2);
    expect(calls.armInputs.map((i) => i.expectedHead)).toEqual([head, head]);
    expect(calls.merge).toBe(0);
    expect(calls.order.slice(-3)).toEqual(['arm', 'arm', 'merged']);
  });

  it('等检查之后由同一次挂合并入口直接合上：不另走不核 CI 的直接合，合并提交仍进关单回执', async () => {
    const world = createFakeWorld();
    const commit = 'e'.repeat(40);
    const { tasks, calls } = scripted({
      arm: (n, input) =>
        n === 1 ? waitingCheck(input, ['merge-gate']) : { armed: false, merged: true, mergeCommit: commit },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.arm).toBe(2);
    expect(calls.merged).toBe(0);
    expect(calls.merge).toBe(0);
    expect(world.alerts).toEqual([]);
    expect(world.states.some((s) => s.doing === '等检查：merge-gate')).toBe(true);
    expect(world.callsOf('closeIssue')[0]?.input).toMatchObject({
      reason: 'completed',
      comment: expect.stringContaining(`（${commit.slice(0, 7)}）`),
    });
  });

  it('【故意造出的失败】只有 ci_not_green 原文、没有还在跑的检查：马上停下，不拿这句话反复挂', async () => {
    const world = createFakeWorld();
    const why = `${ORIGIN}；必过检查没查成：检查列表翻不完`;
    const { tasks, calls } = scripted({
      arm: (n) => (n === 1 ? { armed: false, merged: false, why } : ARMED),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '没查成，停下');
        expect(s.lastProblem).toContain('自动合并没挂上');
        expect(world.alerts[0]?.detail).toContain('没查成');
        expect(world.alerts[0]?.detail).toContain('ci_not_green');
        expect(calls.arm).toBe(1);
        expect(world.states.some((st) => st.doing.startsWith('等检查：'))).toBe(false);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.arm).toBe(2);
    expect(world.alerts).toHaveLength(1);
  });

  it('【故意造出的失败】checksPending 没有检查名：不当成还在跑', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      arm: (n, input) =>
        n === 1
          ? {
              armed: false,
              merged: false,
              why: `${ORIGIN}；必过检查没查成`,
              checksPending: { names: [], head: input.expectedHead, detail: ORIGIN },
            }
          : ARMED,
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '空的检查名，停下');
        expect(s.lastProblem).toContain('自动合并没挂上');
        expect(calls.arm).toBe(1);
        expect(world.states.some((st) => st.doing.startsWith('等检查：'))).toBe(false);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '停' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
  });

  it('原文写着没跑完、挂合并时现读是真红：确认后返工，不写成等检查', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      arm: (n, input) => (n <= 2 ? redCheck(input) : ARMED),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.states.some((s) => s.doing === '检查红了：merge-gate')).toBe(true);
    expect(world.states.some((s) => s.doing.startsWith('等检查：'))).toBe(false);
    const feedback = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(feedback).toContain('检查红了：merge-gate');
    expect(feedback).toContain('cold-verify 没过');
    expect(calls.segment[0]?.feedback.join('\n') ?? '').not.toContain('检查红了');
    expect(world.alerts).toEqual([]);
  });

  it('红了一下又变回还在跑：不返工，等检查绿了自己挂上', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      arm: (n, input) => {
        if (n === 1) return redCheck(input);
        if (n === 2) return waitingCheck(input, ['merge-gate']);
        return ARMED;
      },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(1);
    expect(world.states.some((s) => s.doing === '检查红了：merge-gate')).toBe(true);
    expect(world.states.some((s) => s.doing === '等检查：merge-gate')).toBe(true);
    expect(world.alerts).toEqual([]);
    expect(calls.merge).toBe(0);
  });

  it('【故意造出的失败】等检查到点还没跑完：停下，留下 PR、头、检查名和原始原因；点继续才重新有界等待', async () => {
    expect(polls).toBe(45);
    const world = createFakeWorld();
    const head = fakeHead(101);
    const later = '后来的拒绝原文，不应盖掉原始原因';
    // 停下那一刻挂过几次。停下之前一直还在跑；继续后第一次仍在跑（证明期限已丢掉、重新起算），下一次才挂上。
    let parkedAt: number | null = null;
    const { tasks, calls } = scripted({
      arm: (n, input) => {
        if (parkedAt === null) {
          return waitingCheck(input, n === 1 ? ['merge-gate'] : ['check'], n === 1 ? ORIGIN : later);
        }
        if (n === parkedAt + 1) return waitingCheck(input, ['merge-gate']);
        return ARMED;
      },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await env.sleep('18 minutes');
        const s = await statusUntil(h, parked, '等检查超时，停下');
        parkedAt = calls.arm;
        expect(s.phase).toBe('parked');
        expect(s.lastProblem).toBe('等检查超时');
        expect(s.prNumber).not.toBeNull();
        // 按工作流时间到点，不按次数：每 20 秒一次，15 分钟里至多 45 次，到点那一下不再挂
        expect(calls.arm).toBeLessThanOrEqual(polls + 1);
        expect(calls.arm).toBeGreaterThan(polls - 5);
        expect(calls.segment).toHaveLength(1);
        expect(calls.merge).toBe(0);
        expect(calls.armInputs.every((i) => i.expectedHead === head)).toBe(true);
        const detail = world.alerts[0]?.detail ?? '';
        expect(world.alerts).toHaveLength(1);
        expect(world.alerts[0]?.title).toBe('等检查超时');
        expect(detail).toContain(`PR #${s.prNumber}`);
        expect(detail).toContain(head);
        expect(detail).toContain('check（一开始在等：merge-gate）');
        expect(detail).toContain(`原始原因：${ORIGIN}`);
        expect(detail).not.toContain(later);
        expect(world.states.some((st) => st.doing === '等检查：merge-gate')).toBe(true);
        expect(world.states.some((st) => st.doing === '等检查：check')).toBe(true);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, head });
    // 停下时丢掉这一段的期限：继续后先再等一次，不是当场又超时
    expect(calls.arm).toBe((parkedAt ?? 0) + 2);
    expect(world.alerts).toHaveLength(1);
    expect(calls.merge).toBe(0);
  });

  it('【故意造出的失败】等检查时上游慢、挂合并一直重试：活动的排队和重试退避算进同一份 15 分钟，到点停下，不另开期限', async () => {
    const world = createFakeWorld();
    const head = fakeHead(101);
    // 第一次照常回还在跑；之后上游一直 502，每一下都把 Temporal 的 3 次尝试和退避用完（服务端时间在走）。
    let failing = true;
    const { tasks, calls } = scripted({
      arm: (n, input) => {
        if (n === 1) return waitingCheck(input, ['merge-gate']);
        if (failing) throw new PortError('GITHUB_UNAVAILABLE', 'GitHub 502', { retryable: true });
        return ARMED;
      },
    });
    const armAt: number[] = [];
    const scriptedArm = tasks.armAutoMerge;
    if (!scriptedArm) throw new Error('脚本没装 armAutoMerge');
    tasks.armAutoMerge = async (armInput, ctx) => {
      armAt.push(await env.currentTimeMs());
      return scriptedArm(armInput, ctx);
    };
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await env.sleep('25 minutes');
        const s = await statusUntil(h, parked, '上游慢耗尽期限，停下');
        expect(s.lastProblem).toBe('等检查超时');
        const parkedAt = Date.parse(s.waiting?.since ?? '');
        const first = armAt[0] ?? Number.NaN;
        // 从第一次挂合并开调起算，停下不晚于 15 分钟（加几秒工作流任务的零头）。
        expect(parkedAt - first).toBeLessThanOrEqual(ARM_PENDING_CHECKS_MINUTES * 60_000 + 5_000);
        expect(parkedAt - first).toBeGreaterThanOrEqual(ARM_PENDING_CHECKS_MINUTES * 60_000 - 40_000);
        // 历史里：等检查里的每一下挂合并都带着剩余期限（scheduleToClose），单次尝试不超过它，期限只减不增。
        const budgets = armBudgets((await h.fetchHistory()).events ?? []);
        expect(budgets[0]?.startToClose).toBe(300);
        const bounded = budgets.slice(1);
        // 每一下是至多 3 次尝试加退避、再睡 20 秒：远不到 45 下就到点，不是按次数停的。
        expect(bounded.length).toBeGreaterThan(5);
        expect(bounded.length).toBeLessThan(30);
        expect(calls.arm).toBeGreaterThan(bounded.length + 1);
        expect(calls.arm).toBeLessThanOrEqual(1 + 3 * bounded.length);
        for (const [i, b] of bounded.entries()) {
          expect(b.scheduleToClose).toBeGreaterThan(0);
          expect(b.scheduleToClose).toBeLessThanOrEqual(ARM_PENDING_CHECKS_MINUTES * 60);
          expect(b.startToClose).toBeLessThanOrEqual(Math.min(300, b.scheduleToClose));
          if (i > 0) expect(b.scheduleToClose).toBeLessThan(bounded[i - 1]?.scheduleToClose ?? 0);
        }
        const detail = world.alerts[0]?.detail ?? '';
        expect(world.alerts).toHaveLength(1);
        expect(world.alerts[0]?.title).toBe('等检查超时');
        expect(detail).toContain(`PR #${s.prNumber}`);
        expect(detail).toContain(head);
        expect(detail).toContain('merge-gate');
        expect(detail).toContain(`原始原因：${ORIGIN}`);
        expect(calls.merge).toBe(0);
        failing = false;
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, head });
    expect(calls.armInputs.every((i) => i.expectedHead === head)).toBe(true);
    expect(world.alerts).toHaveLength(1);
    expect(calls.merge).toBe(0);
  });

  it('【故意造出的失败】等检查时挂合并碰到认证失败：当场停下报原因，不当成还在跑接着等', async () => {
    const world = createFakeWorld();
    const head = fakeHead(101);
    const { tasks, calls } = scripted({
      arm: (n, input) => {
        if (n === 1) return waitingCheck(input, ['merge-gate']);
        if (n === 2) throw new PortError('AUTH_REQUIRED', 'GitHub 令牌失效', { retryable: false });
        return ARMED;
      },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await env.sleep('1 minute');
        const s = await statusUntil(h, parked, '认证失败，停下');
        expect(s.lastProblem).toContain('AUTH_REQUIRED');
        expect(calls.arm).toBe(2);
        const detail = world.alerts[0]?.detail ?? '';
        expect(detail).toContain('GitHub 令牌失效');
        expect(detail).toContain(head);
        expect(detail).toContain(`原始原因：${ORIGIN}`);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, head });
    expect(calls.arm).toBe(3);
    expect(world.alerts).toHaveLength(1);
  });

  it('等检查期间头被别人改了：不沿用旧头的批准和绿，重走 CI、冷验收、查路径', async () => {
    const world = createFakeWorld();
    const moved = fakeHead(777);
    const approved = 'AGENTS.md（通用段）';
    const { tasks, calls } = scripted({
      guarded: (n) => (n === 1 ? { standards: [approved] } : { standards: [] }),
      arm: (n, input) => {
        if (n === 1) return waitingCheck(input, ['merge-gate']);
        if (n === 2) return { armed: false, merged: false, why: 'PR 的头变了', headMoved: moved };
        return ARMED;
      },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const gate = await statusUntil(h, parked, '改标准，停下');
        expect(gate.waiting?.detail).toContain('标准路径');
        expect(world.alerts[0]?.detail).toContain(approved);
        await h.signal(taskContinueSignal, { by: 'frank' });
        await env.sleep('1 minute');
        const movedPark = await statusUntil(
          h,
          (st) => parked(st) && (st.lastProblem ?? '').includes('头被别人改了'),
          '头被改，停下',
        );
        expect(movedPark.lastProblem).toContain('头被别人改了');
        expect(world.alerts.at(-1)?.detail).toContain(moved);
        expect(world.alerts.at(-1)?.detail).toContain('重跑 CI 和验收');
        expect(world.states.some((st) => st.doing === '等检查：merge-gate' && st.state === 'running')).toBe(
          true,
        );
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    const head = fakeHead(101);
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, verifyRounds: 1, head: moved });
    expect(calls.merge).toBe(0);
    expect(calls.armInputs.map((i) => i.expectedHead)).toEqual([head, head, moved]);
    expect(calls.verify.map((v) => v.headSha)).toEqual([head, moved]);
    expect(calls.verify[1]?.round).toBe(1);
    expect(world.callsOf('waitCi').map((c) => (c.input as { head: string }).head)).toEqual([head, moved]);
    expect(calls.guardedInputs.map((i) => i.approved?.standards)).toEqual([undefined, [approved], undefined]);
  });

  it('等检查时交回的头已经不是这一轮的头：重走 CI 和冷验收，不在旧头上接着等', async () => {
    const world = createFakeWorld();
    const moved = fakeHead(777);
    const head = fakeHead(101);
    const { tasks, calls } = scripted({
      arm: (n, input) => {
        if (n === 1) return waitingCheck(input, ['merge-gate']);
        if (n === 2) {
          return {
            armed: false,
            merged: false,
            why: ORIGIN,
            checksPending: { names: ['merge-gate'], head: moved, detail: ORIGIN },
          };
        }
        return ARMED;
      },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await env.sleep('1 minute');
        const s = await statusUntil(h, parked, '头对不上，停下');
        expect(s.lastProblem).toContain('头被别人改了');
        expect(world.alerts[0]?.detail).toContain(moved);
        expect(world.alerts[0]?.detail).toContain('重跑 CI 和验收');
        expect(world.states.some((st) => st.doing === '等检查：merge-gate')).toBe(true);
        expect(calls.arm).toBe(2);
        expect(calls.armInputs[1]?.expectedHead).toBe(head);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', head: moved, rounds: 1 });
    expect(calls.segment).toHaveLength(1);
    expect(calls.merge).toBe(0);
    expect(calls.armInputs[2]?.expectedHead).toBe(moved);
    expect(calls.verify.map((v) => v.headSha)).toEqual([head, moved]);
    expect(world.callsOf('waitCi').map((c) => (c.input as { head: string }).head)).toContain(moved);
  });

  it('【故意造出的失败】真红绑的是另一个头：不拿旧头返工，重走 CI 和冷验收', async () => {
    const world = createFakeWorld();
    const moved = fakeHead(777);
    const head = fakeHead(101);
    const { tasks, calls } = scripted({
      arm: (n) =>
        n === 1
          ? {
              armed: false,
              merged: false,
              why: ORIGIN,
              checksRed: {
                failedChecks: ['merge-gate'],
                detail: 'merge-gate：cold-verify 没过',
                head: moved,
              },
            }
          : ARMED,
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '红在另一个头上，停下');
        expect(s.lastProblem).toContain('头被别人改了');
        expect(world.alerts[0]?.detail).toContain(moved);
        expect(world.alerts[0]?.detail).toContain('重跑 CI 和验收');
        expect(world.states.some((st) => st.doing.startsWith('检查红了：'))).toBe(false);
        expect(world.states.some((st) => st.doing.startsWith('等检查：'))).toBe(false);
        expect(calls.segment).toHaveLength(1);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', head: moved, rounds: 1 });
    expect(calls.segment).toHaveLength(1);
    expect(calls.segment[0]?.feedback.join('\n') ?? '').not.toContain('检查红了');
    expect(calls.merge).toBe(0);
    expect(calls.verify.map((v) => v.headSha)).toEqual([head, moved]);
    expect(calls.armInputs.map((i) => i.expectedHead)).toEqual([head, moved]);
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
        // 认不出的原路重试 1 分钟起（决定 0093 分档冷却）：只查状态时测试服务端不跳时间，这里把时间拨过去
        await env.sleep('2 minutes');
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

describe('任务工作流 · model_mismatch 自动换同模型路由，第二次才停下报人', { timeout: 60_000 }, () => {
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
  const channelWorld = (
    channels: string[],
    picks: PickRouteInput[],
    modelByChannel: Record<string, string> = {},
  ) =>
    createFakeWorld({
      route: (i) => {
        picks.push(i);
        const route = channels
          .map((channel) => ({ ...via(channel), modelId: modelByChannel[channel] ?? 'm1' }))
          .find((r) => !i.avoidRouteIds.includes(r.routeId) && (!i.models || i.models.includes(r.modelId)));
        return route
          ? { ok: true, route, why: '测试' }
          : {
              ok: false,
              waitFor: 'none',
              detail: i.models ? `模型 ${i.models.join('、')} 的渠道都用尽了` : '这个模型的渠道都用尽了',
            };
      },
    });

  it('【故意造出的失败】连续两次 model_mismatch 才停下报人：只自动换路一次，不换第三条渠道', async () => {
    const picks: PickRouteInput[] = [];
    const world = channelWorld(['c1', 'c2', 'c3', 'c4', 'c5'], picks);
    const { tasks, calls } = scripted({ segment: async () => REJECTED });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '第二次模型对不上，停下等人');
        expect(s.lastProblem).toBe('回话的模型不是点名的那个：换了一条同档路由仍对不上，停下等人');
        expect(s.lastProblem).not.toContain('挂起并报警');
        expect(calls.segment.map((x) => x.route.channelId)).toEqual(['c1', 'c2']);
        expect(calls.segment[1]?.resumeSessionId).toBeUndefined();
        expect(picks).toHaveLength(2);
        expect(picks[0]?.failedChannel).toBeUndefined();
        expect(picks[1]?.avoidRouteIds).toEqual(['r-c1']);
        expect(picks[1]?.models).toEqual(['m1']);
        expect(picks[1]?.tier).toEqual(picks[0]?.tier);
        expect(world.alerts[0]).toMatchObject({ level: 'stuck' });
        expect(calls.segment).toHaveLength(2);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        return h.result().catch(() => undefined);
      },
      { tasks },
    );
    expect(calls.segment).toHaveLength(2);
    expect(world.count('createWorktree')).toBe(1);
  });

  it('model_mismatch 自动重派成功后不需要点「继续」：不标记 failedChannel', async () => {
    const picks: PickRouteInput[] = [];
    const world = channelWorld(['c1', 'c2'], picks);
    const { tasks, calls } = scripted({
      segment: async (_i, n) => (n === 1 ? REJECTED : OK_SEGMENT),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment.map((x) => x.route.channelId)).toEqual(['c1', 'c2']);
    expect(calls.segment[1]?.resumeSessionId).toBeUndefined();
    expect(picks[1]?.failedChannel).toBeUndefined();
    expect(picks[1]?.avoidRouteIds).toEqual(['r-c1']);
    expect(picks[1]?.stickRouteId).toBeUndefined();
    expect(world.count('createWorktree')).toBe(1);
  });

  it('model_mismatch 重派只找同一个模型的另一条路由，不误派到下一模型', async () => {
    const picks: PickRouteInput[] = [];
    const world = channelWorld(['c1', 'c2', 'c3'], picks, { c2: 'm2' });
    const { tasks, calls } = scripted({
      segment: async (_i, n) => (n === 1 ? REJECTED : OK_SEGMENT),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment.map((x) => [x.route.channelId, x.route.modelId])).toEqual([
      ['c1', 'm1'],
      ['c3', 'm1'],
    ]);
    expect(picks[1]?.models).toEqual(['m1']);
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

  /** hard 暂停一次、继续，返回两次会话的入参和判续会话的入参（决定 0088）。 */
  async function pauseAndContinue(resume: Script['resume']) {
    const world = createFakeWorld();
    const { gate, segment } = gated();
    const { tasks, calls } = scripted({ segment: (_i, n, signal) => segment(n, signal), resume });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitUntil(() => calls.segment.length > 0, '会话在跑');
        await h.signal(taskPauseSignal, { by: 'frank', reason: '发版', mode: 'hard' });
        await statusUntil(h, paused, '停进已暂停');
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(gate.aborted).toBe(true);
    return { run, world, calls };
  }

  it('hard 暂停后继续：按会话号续上原会话，提示词只补被打断的原因，进度写「续上一段的会话」', async () => {
    const { run, world, calls } = await pauseAndContinue(() => ({
      kind: 'resume',
      sessionId: 'sess-9',
      runId: 'run-0002',
    }));
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(2);
    const [first, second] = calls.segment;
    expect(first?.resumeSessionId).toBeUndefined();
    expect(second).toMatchObject({ resumeSessionId: 'sess-9', interrupted: '被人暂停（frank）：发版' });
    expect(second?.worktreePath).toBe(first?.worktreePath);
    // 只判了一次：拿这一次选的路由、按被取消那一段的起跑时刻找
    expect(calls.resume).toHaveLength(1);
    expect(calls.resume[0]).toMatchObject({ taskId: first?.taskId, routeId: second?.route.routeId });
    expect(calls.resume[0]?.previous).toHaveProperty('startedAfter');
    expect(world.states.some((s) => s.doing.includes('续上一段的会话'))).toBe(true);
  });

  it('续不上（上一段没记下会话号）：退回原分支原树开新会话带 interrupted，进度写明为什么没续上', async () => {
    const { run, world, calls } = await pauseAndContinue(() => ({
      kind: 'new',
      reason: '上一段没记下会话号',
    }));
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    const second = calls.segment[1];
    expect(second?.resumeSessionId).toBeUndefined();
    expect(second?.interrupted).toBe('被人暂停（frank）：发版');
    expect(world.states.some((s) => s.doing.includes('没续上会话（上一段没记下会话号），开新会话'))).toBe(
      true,
    );
  });

  it('换了执行方式续不上、判续会话没查成：都退回新会话，不停下等人', async () => {
    const swapped = await pauseAndContinue(() => ({
      kind: 'new',
      reason: '换了执行方式（claude-code → cursor-agent）',
    }));
    expect(swapped.calls.segment[1]?.resumeSessionId).toBeUndefined();
    expect(swapped.world.states.some((s) => s.doing.includes('换了执行方式'))).toBe(true);
    const broken = await pauseAndContinue(() => {
      throw new PortError('DB_DOWN', '库一时不通', { retryable: false });
    });
    expect(broken.run).toMatchObject({ outcome: 'merged' });
    expect(broken.calls.segment[1]?.resumeSessionId).toBeUndefined();
    expect(broken.world.states.some((s) => s.doing.includes('续会话没查成'))).toBe(true);
    expect(broken.world.alerts).toEqual([]);
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
      // 头一回用尽自动续（决定 0093）也重读一次单子：前两次读到旧正文，点「继续」后读到新的
      brief: (n) => (n <= 2 ? briefSaying('旧正文', ['旧验收条']) : briefSaying('新正文', ['新验收条'])),
      verify: (_input, n) =>
        n === 6
          ? { pass: true, problems: [], round: 2 }
          : { pass: false, problems: ['还没做完'], round: n % 2 === 1 ? 1 : 2 },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(
          h,
          (s) => parked(s) && (s.waiting?.detail.includes('验收 2 轮都没过') ?? false),
          '验收 2 轮第二回用尽，停下',
        );
        expect(calls.segment).toHaveLength(5);
        expect(calls.verify).toHaveLength(4);
        expect(calls.verify.every((item) => item.what === '旧正文')).toBe(true);
        await h.signal(taskContinueSignal, { by: 'frank' });
        await waitUntil(
          () =>
            calls.segment.length > 5 || world.alerts.some((alert) => alert.title.includes('动手 3 轮都没过')),
          '继续后要么再动手一轮，要么错误地立刻报动手用尽',
        );
        expect(world.alerts.some((alert) => alert.title.includes('动手 3 轮都没过'))).toBe(false);
        expect(calls.verify[4]).toMatchObject({ what: '新正文', howToFinish: ['新验收条'], round: 1 });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.brief).toBe(3);
    expect(calls.segment).toHaveLength(6);
    expect(calls.segment[5]?.brief).toMatchObject({ request: '新正文', acceptance: ['新验收条'] });
    expect(calls.verify.map((item) => item.round)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(
      calls.verify.slice(4).every((item) => item.what === '新正文' && item.howToFinish[0] === '新验收条'),
    ).toBe(true);
  });

  it('同一次继续里动手仍停在上限；自动续那一次加点「继续」累计超过 3 次不再清零，停下并写明交指挥官', async () => {
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
        // 头一回用尽自动续了一次（决定 0093），第二回才停下
        expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS * 2);
        for (let time = 0; time < 2; time += 1) {
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
    // 避开模型时连它那一族一起避开（决定 0093）
    expect(picks[2]?.avoidFamilies).toEqual(['claude']);
    expect(picks[1]?.avoidFamilies).toBeUndefined();
    expect(calls.segment[2]?.route).toMatchObject({ routeId: 'r3', modelId: 'm2' });
    const opinion = calls.segment[2]?.feedback.join('\n') ?? '';
    expect(opinion).toContain('上一轮用的是路由 r2');
    expect(opinion).toContain('这一轮避开它');
    expect(opinion).toContain('也避开模型 m1和它那一族（claude');
  });

  it('连着两轮没有提交、别的族没有路由：退回只避开模型，同族换一个模型', async () => {
    const world = createFakeWorld({
      routes: [
        { routeId: 'r1', poolId: 'p1', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
        { routeId: 'r2', poolId: 'p2', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
        { routeId: 'r4', poolId: 'p4', modelId: 'm3', family: 'claude', hostId: 'claude-code' },
      ],
    });
    const { tasks, calls } = scripted({ delivery: deliveryAfterMisses(2) });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 3 });
    expect(calls.segment[2]?.route.modelId).toBe('m3');
    const picks = routePicks(world);
    expect(picks.at(-2)?.avoidFamilies).toEqual(['claude']);
    expect(picks.at(-1)?.avoidFamilies).toBeUndefined();
    expect(picks.at(-1)?.avoidModelIds).toEqual(['m1']);
  });

  it('交给冷验收的作者族用选路给的作者族（unclassified 的 cursor 模型记成 gpt）', async () => {
    const world = createFakeWorld({
      routes: [
        {
          routeId: 'rc',
          poolId: 'pc',
          modelId: 'cursor:gpt-5.4-mini-high',
          family: 'unclassified',
          authorFamily: 'gpt',
          hostId: 'api-shell',
        },
      ],
    });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.verify[0]?.authorFamilies).toEqual(['gpt']);
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
    const { tasks, calls } = scripted({ delivery: deliveryAfterMisses(6) }); // 头一回用尽自动续一次（决定 0093），第二回才停下
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

describe('任务工作流 · 验收责任（#3037）：合并不等于关单', { timeout: 60_000 }, () => {
  const FIELD = ['现场 add/check 五条', '线上数据核对'];

  it('验收过了、带「不归我验」：照常挂自动合并、合并；不关单，验收责任连 PR、头、合并回执记下，PR 说明改 Refs', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      verify: (_i, n) => ({ pass: true, problems: [], round: n === 1 ? 1 : 2, outOfScope: FIELD }),
      arm: () => {
        expect(world.callsOf('updatePrBody').at(-1)?.input.body.requirementRefs).toBe(true);
        return { armed: true, merged: false };
      },
    });
    const i = input();
    const run = await withWorker(env, world, async (q) => (await start(q, i)).result() as Promise<TaskRun>, {
      tasks,
    });
    // 代码照合：不因不归我验判没过、不回炉，挂自动合并、等合并都走了
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1, verifyRounds: 1, acceptanceOpen: 1 });
    expect(calls.order).toEqual(['brief', 'segment', 'delivery', 'verify', 'guarded', 'arm', 'merged']);
    expect(world.count('closeIssue')).toBe(0);
    // 记下的验收责任：精确到仓、单、PR、头，原验收项原样，带合并回执
    expect(world.callsOf('acceptanceDuties').at(-1)?.input).toMatchObject({
      taskId: i.taskId,
      issueNumber: 12,
      record: [{ prNumber: run.prNumber, head: run.head, items: FIELD, mergeCommit: 'abc1234567890' }],
    });
    expect(world.duties).toEqual([
      {
        taskId: i.taskId,
        repo: `${i.repo.owner}/${i.repo.name}`,
        issueNumber: 12,
        prNumber: run.prNumber,
        head: run.head,
        items: FIELD,
        source: 'cold_verify',
        mergeCommit: 'abc1234567890',
        settled: false,
      },
    ]);
    const body = world.callsOf('updatePrBody').at(-1)?.input.body;
    expect(body).toMatchObject({ requirement: 12, requirementRefs: true });
    expect(body?.owed).toEqual(FIELD.map((x) => `待人验：${x}`));
    expect(world.states.at(-1)).toMatchObject({ state: 'done' });
    expect(world.states.at(-1)?.doing).toContain('验收责任 2 条待人验');
    // 收树照常（不存档）
    expect(world.callsOf('removeWorktree')[0]?.input).toMatchObject({ archive: false });
  });

  it('合前 Refs 写失败先重试，只有成功回执后才挂自动合并', async () => {
    const world = createFakeWorld({ failFirst: { updatePrBody: 1 } });
    const { tasks } = scripted({
      verify: () => ({ pass: true, problems: [], round: 1, outOfScope: FIELD }),
      arm: () => {
        expect(world.callsOf('updatePrBody').some((c) => c.ok === true && c.input.body.requirementRefs)).toBe(
          true,
        );
        return { armed: true, merged: false };
      },
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.callsOf('updatePrBody')[0]?.ok).toBe(false);
    expect(world.count('closeIssue')).toBe(0);
  });

  it('没有「不归我验」的普通代码单：照常关单，PR 说明不改 Refs', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(run).not.toHaveProperty('acceptanceOpen');
    expect(world.callsOf('acceptanceDuties')[0]?.input.record).toEqual([]);
    expect(world.callsOf('closeIssue')[0]?.input).toMatchObject({ issueNumber: 12, reason: 'completed' });
    expect(world.callsOf('updatePrBody').some((c) => c.input.body.requirementRefs)).toBe(false);
  });

  it('库里已有这张单开着的验收责任（上一代、本机租约时期转的人）：这一代没有不归我验也不关单（重启、换执行方不丢）', async () => {
    const i = input();
    const world = createFakeWorld({
      duties: [
        {
          taskId: i.taskId,
          repo: `${i.repo.owner}/${i.repo.name}`,
          issueNumber: 12,
          prNumber: 90,
          head: fakeHead(90),
          items: ['现场 add/check 五条'],
          source: 'cold_verify',
          mergeCommit: null,
          settled: false,
        },
      ],
    });
    const { tasks } = scripted();
    const run = await withWorker(env, world, async (q) => (await start(q, i)).result() as Promise<TaskRun>, {
      tasks,
    });
    expect(run).toMatchObject({ outcome: 'merged', acceptanceOpen: 1 });
    expect(world.count('closeIssue')).toBe(0);
    expect(world.duties).toHaveLength(1);
  });

  it('只有最终验收完成记下了（库里那一行收掉）才按标准关单', async () => {
    const i = input();
    const world = createFakeWorld({
      duties: [
        {
          taskId: i.taskId,
          repo: `${i.repo.owner}/${i.repo.name}`,
          issueNumber: 12,
          prNumber: 90,
          head: fakeHead(90),
          items: ['现场 add/check 五条'],
          source: 'cold_verify',
          mergeCommit: 'm',
          settled: true,
        },
      ],
    });
    const { tasks } = scripted();
    await withWorker(env, world, async (q) => (await start(q, i)).result() as Promise<TaskRun>, { tasks });
    expect(world.callsOf('closeIssue')[0]?.input).toMatchObject({ issueNumber: 12, reason: 'completed' });
  });

  it('【故意造出的失败】验收责任读不成：不关单（不当成没有待验的），重试或停下，人放弃后照样不关', async () => {
    const world = createFakeWorld({ failFirst: { acceptanceDuties: 1_000_000 } });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await world.until(() => world.count('acceptanceDuties') >= 2, '验收责任读了不止一次');
        expect(world.count('closeIssue')).toBe(0);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测试收尾' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(world.count('closeIssue')).toBe(0);
  });

  it('同一个头转了两次人（验收重来）、合并回执再来一次：库里只一行，原验收项并起来', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted({
      verify: (_i, n) => ({
        pass: true,
        problems: [],
        round: n === 1 ? 1 : 2,
        outOfScope: n === 1 ? [FIELD[0] ?? ''] : FIELD,
      }),
      // 头被人换了一次：同一个 PR 两个头，各一行
      merged: (n) =>
        n === 1 ? { state: 'merged', mergeCommit: 'abc1234567890' } : { state: 'merged', mergeCommit: 'x' },
    });
    const i = input();
    await withWorker(env, world, async (q) => (await start(q, i)).result() as Promise<TaskRun>, { tasks });
    // 工作流把这一次的再交一遍：和活动那边记过的落在同一行，不重复
    const again = await world.ports.acceptanceDuties(
      {
        taskId: i.taskId,
        repo: i.repo,
        issueNumber: 12,
        record: [
          {
            prNumber: world.duties[0]?.prNumber ?? 0,
            head: world.duties[0]?.head ?? '',
            items: FIELD,
            mergeCommit: 'zzz',
          },
        ],
      },
      { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1, lastHeartbeat: undefined },
    );
    expect(again.open).toHaveLength(1);
    expect(again.open[0]?.mergeCommit).toBe('abc1234567890');
    expect(world.duties).toHaveLength(1);
  });
});
