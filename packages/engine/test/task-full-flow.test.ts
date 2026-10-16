// 全程模式第一期（#2826）：同一个会话从动手走到合并。CI 红、和主线冲突、冷验收被拒都续同一个会话、不算新的一轮；
// 上限推送 6 次、冷验收被拒 2 次，到了停下；续不上开新会话带同样的信息。engine.flowMode 是 three 时和原来一模一样。
// 真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动（定模式那一步也脚本化：分组的边界在 flow-mode.test.ts）。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EngineTasks } from '../src/activities.ts';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, type FakeScript } from '../src/fakes.ts';
import {
  type DecideFlowModeResult,
  MAX_FULL_PUSHES,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { type Script, scripted } from './task-script.ts';

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
    workflowId: taskWorkflowId(i.repo, i.issueNumber, 1),
    args: [i],
  });
}

const FULL: DecideFlowModeResult = { mode: 'full', source: 'hash', reason: null };
const RESUME_ALWAYS = () => ({ kind: 'resume' as const, sessionId: 'sess-1', runId: 'run-1' });
const statusOf = (h: WorkflowHandle): Promise<TaskStatus> => h.query(taskStatusQuery);

/** 跑到合上，回结果、世界和脚本的记账。 */
async function runToEnd(script: Partial<FakeScript>, over: Partial<Script>) {
  const world = createFakeWorld(script);
  const { tasks, calls } = scripted({ flow: () => FULL, resume: RESUME_ALWAYS, ...over });
  const run = await withWorker(
    env,
    world,
    async (q) => (await start(q, input())).result() as Promise<TaskRun>,
    { tasks },
  );
  return { run, world, calls };
}

describe('全程（#2826）', { timeout: 60_000 }, () => {
  it('全程合并：第一次选路之后、第一段动手之前定一次模式；动手那一段带全程；一轮合上，task_rounds 记 full', async () => {
    const { run, world, calls } = await runToEnd({}, {});
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    // 定模式只问一次，带选中的模型、已知的模块、档位
    expect(calls.flow).toHaveLength(1);
    expect(calls.flow[0]).toMatchObject({ issueNumber: 12, modelId: 'm1' });
    expect(calls.flow[0]?.touches.length).toBeGreaterThan(0);
    expect(calls.flow[0]?.stratum).toBeTruthy();
    expect(calls.flowAfterSegments).toEqual([0]);
    expect(calls.segment[0]?.flowMode).toBe('full');
    const rows = world.callsOf('recordRound').map((c) => c.input);
    expect(rows.map((r) => [r.round, r.outcome, r.flowMode])).toEqual([[1, 'merged', 'full']]);
    expect(world.states.some((s) => s.doing.includes('全程'))).toBe(true);
  });

  it('CI 红：带失败 job 和日志尾巴续同一个会话修好，不算新的一轮', async () => {
    const detail = '红的 job：check\n\n【check】failure\n输出结尾：\nFAIL task.test.ts';
    const { run, world, calls } = await runToEnd(
      {
        ci: (_i, n) =>
          n === 1 ? { state: 'red', failedChecks: ['check'], digest: 'check：failure', detail } : undefined,
      },
      {},
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[1]?.resumeSessionId).toBe('sess-1');
    expect(calls.segment[1]?.flowMode).toBe('full');
    expect(calls.segment[1]?.feedback).toEqual(['CI 红了：check', 'check：failure', detail]);
    expect(calls.flow).toHaveLength(1); // 定一次，不再读配置
    const rows = world.callsOf('recordRound').map((c) => c.input);
    expect(rows.map((r) => [r.round, r.outcome, r.flowMode])).toEqual([
      [1, 'ci_red', 'full'],
      [1, 'merged', 'full'],
    ]);
  });

  it('和主线冲突：引擎先并，并不干净才把冲突文件交回同一个会话', async () => {
    const { run, calls } = await runToEnd(
      {
        ci: (_i, n) => (n === 1 ? { state: 'conflict' } : undefined),
        sync: (_i, n) =>
          n === 1 ? { state: 'conflict', conflictFiles: ['packages/web/src/pages/a.tsx'] } : undefined,
      },
      {},
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[1]?.resumeSessionId).toBe('sess-1');
    expect(calls.segment[1]?.feedback.join('\n')).toContain('packages/web/src/pages/a.tsx');
  });

  it('冷验收被拒：带拒绝理由续同一个会话', async () => {
    const { run, calls } = await runToEnd(
      {},
      {
        verify: (_i, n) =>
          n === 1
            ? { pass: false, problems: ['页面上没有「验收中」'], round: 1 }
            : { pass: true, problems: [], round: 2 },
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(2);
    expect(calls.segment[1]?.resumeSessionId).toBe('sess-1');
    expect(calls.segment[1]?.feedback).toEqual(['验收没过：页面上没有「验收中」']);
  });

  it('续不上会话：开新会话，把同样的 CI 信息带进去（仍是全程）', async () => {
    const { run, calls, world } = await runToEnd(
      { ci: (_i, n) => (n === 1 ? { state: 'red', failedChecks: ['check'], digest: 'FAIL x' } : undefined) },
      { resume: () => ({ kind: 'new', reason: '换了执行方式' }) },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment[1]?.resumeSessionId).toBeUndefined();
    expect(calls.segment[1]?.flowMode).toBe('full');
    expect(calls.segment[1]?.feedback).toEqual(['CI 红了：check', 'FAIL x']);
    expect(world.states.some((s) => s.doing.includes('没续上会话（换了执行方式'))).toBe(true);
  });

  it(`到上限停下：CI 一直红，推送 ${MAX_FULL_PUSHES} 次后停下等人；一路续同一个会话（不按三段的「连着续两轮开新会话」）`, async () => {
    const world = createFakeWorld({
      ci: () => ({ state: 'red', failedChecks: ['check'], digest: 'FAIL 一直红' }),
    });
    const { tasks, calls } = scripted({ flow: () => FULL, resume: RESUME_ALWAYS });
    const status = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        return pollQuery(
          () => statusOf(h),
          (s) => s.waiting?.kind === 'human',
          '推送到上限停下等人',
        );
      },
      { tasks },
    );
    expect(status.lastProblem).toContain(`推送 ${MAX_FULL_PUSHES} 次`);
    expect(calls.segment).toHaveLength(MAX_FULL_PUSHES);
    expect(calls.segment.slice(1).every((s) => s.resumeSessionId === 'sess-1')).toBe(true);
    expect(status.round).toBe(1);
  });

  it('到上限停下：冷验收被拒 2 次就停下等人，不再起第 3 段', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      flow: () => FULL,
      resume: RESUME_ALWAYS,
      verify: (_i, n) => ({ pass: false, problems: [`第 ${n} 次没过`], round: n === 1 ? 1 : 2 }),
    });
    const status = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        return pollQuery(
          () => statusOf(h),
          (s) => s.waiting?.kind === 'human',
          '验收被拒到上限停下等人',
        );
      },
      { tasks },
    );
    expect(status.lastProblem).toContain('冷验收被拒 2 次');
    expect(calls.segment).toHaveLength(2);
    expect(calls.verify).toHaveLength(2);
  });
});

describe('engine.flowMode 是 three：和原来一模一样（#2826）', { timeout: 60_000 }, () => {
  /** CI 红两轮、验收被拒一次再过：返工、续会话、连着续两轮开新会话都走到。 */
  const busy: Partial<FakeScript> = {
    ci: (_i, n) => (n <= 2 ? { state: 'red', failedChecks: ['check'], digest: `FAIL ${n}` } : undefined),
  };
  const verify: Script['verify'] = (_i, n) =>
    n === 1 ? { pass: false, problems: ['没做到'], round: 1 } : { pass: true, problems: [], round: 2 };

  async function once(withFlow: boolean) {
    const world = createFakeWorld(busy);
    const { tasks, calls } = scripted({ resume: RESUME_ALWAYS, verify });
    if (!withFlow) delete (tasks as Partial<EngineTasks>).decideFlowMode;
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    return { run, calls, world };
  }

  it('分到三段：活动先后、每一段的入参（返工意见、续不续会话）、轮数和没有定模式时一字不差，动手那一段不带全程', async () => {
    const three = await once(true);
    const before = await once(false);
    expect(three.calls.flow).toHaveLength(1);
    expect(three.run).toEqual(before.run);
    expect(three.run.rounds).toBeGreaterThanOrEqual(3);
    expect(three.calls.order).toEqual(before.calls.order);
    const shape = (c: typeof three.calls) =>
      c.segment.map((s) => ({
        feedback: s.feedback,
        resume: s.resumeSessionId ?? null,
        mode: s.mode ?? null,
      }));
    expect(shape(three.calls)).toEqual(shape(before.calls));
    expect(three.calls.segment.every((s) => s.flowMode === undefined)).toBe(true);
    // 每一轮写 task_rounds.flow_mode：分到三段的记 three
    const rows = three.world.callsOf('recordRound').map((c) => c.input);
    expect(rows.every((r) => r.flowMode === 'three')).toBe(true);
    expect(before.world.callsOf('recordRound').map((c) => c.input.outcome)).toEqual(
      rows.map((r) => r.outcome),
    );
  });
});
