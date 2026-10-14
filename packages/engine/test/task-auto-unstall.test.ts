// 停下之前先自动处理一次（决定 0093）：轮数头一回用尽自动换路由续一次；动手会话被引擎叫停、起不来先换路由重派一次；
// 推的时候空交付先再派一轮；CI 结果没查成先自己重查；冷验收和等 CI 同时起。要人看的（卫生检查……）照旧当场停下。
// 真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, FAKE_ROUTES } from '../src/fakes.ts';
import { PortError } from '../src/ports.ts';
import {
  MAX_IMPLEMENT_ROUNDS,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { CI_UNKNOWN_RECHECKS } from '../src/workflows/task-support.ts';
import { freshRepo, pollQuery, useEnv, waitUntil, withWorker } from './helpers.ts';
import { OK_SEGMENT, scripted } from './task-script.ts';

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

const statusUntil = (h: WorkflowHandle, check: (s: TaskStatus) => boolean, what: string) =>
  pollQuery(() => h.query(taskStatusQuery), check, what);
const parked = (s: TaskStatus) => s.waiting?.kind === 'human';
const RED = { state: 'red' as const, failedChecks: ['test (engine)'], digest: 'FAIL a.test.ts' };

describe('轮数头一回用尽：自动换路由续一次（决定 0093）', { timeout: 90_000 }, () => {
  it('动手 3 轮 CI 都红：不停下，第 4 轮避开最近动手的模型、带着 CI 意见直接再动手（不先重走 CI），进度写一行', async () => {
    const world = createFakeWorld({ ci: (_i, n) => (n <= MAX_IMPLEMENT_ROUNDS ? RED : undefined) });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(calls.segment).toHaveLength(MAX_IMPLEMENT_ROUNDS + 1);
    expect(world.alerts.some((a) => a.title.includes('轮都没过'))).toBe(false);
    // 第 4 轮选路避开第 3 轮动手的模型（m1），派到别的模型
    const last = calls.segment.at(-1);
    expect(last?.route.modelId).toBe('m2');
    expect(last?.feedback.join('\n')).toContain('FAIL a.test.ts');
    // 自动续之后直接动手：waitCi 只比会话多不少（没有为同一个红头再等一次 CI）
    expect(world.count('waitCi')).toBe(MAX_IMPLEMENT_ROUNDS + 1);
    expect(world.states.some((s) => s.doing.includes('自动换一条路由') && s.doing.includes('避开 m1'))).toBe(
      true,
    );
  });

  it('只有一个模型可换：照旧派原来那条，不死等', async () => {
    const world = createFakeWorld({
      routes: FAKE_ROUTES.filter((r) => r.modelId === 'm1'),
      ci: (_i, n) => (n <= MAX_IMPLEMENT_ROUNDS ? RED : undefined),
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
    expect(run.outcome).toBe('merged');
    expect(calls.segment.at(-1)?.route.modelId).toBe('m1');
  });

  it('【故意造出的失败】自动续之后又用尽：这回停下等人（只自动一次）', async () => {
    const world = createFakeWorld({ ci: (_i, n) => (n <= 2 * MAX_IMPLEMENT_ROUNDS ? RED : undefined) });
    const { tasks, calls } = scripted();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '第二次用尽停下');
        expect(s.waiting?.detail).toContain('动手 3 轮都没过');
        expect(calls.segment).toHaveLength(2 * MAX_IMPLEMENT_ROUNDS);
        await h.terminate('测完了');
      },
      { tasks },
    );
  });

  it('验收 2 轮用尽：不停下，轮数清零、接着验新头；下一轮动手避开最近的模型', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      verify: (_i, n) =>
        n <= 2
          ? { pass: false, problems: [`第 ${n} 次：没做到验收条`], round: n === 1 ? 1 : 2 }
          : { pass: true, problems: [], round: 1 },
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
    expect(world.alerts.some((a) => a.title.includes('验收 2 轮都没过'))).toBe(false);
    expect(calls.verify.at(-1)?.round).toBe(1);
    expect(world.states.some((s) => s.doing.includes('验收 2 轮都没过：自动换一条路由'))).toBe(true);
  });
});

describe('动手会话没跑成：先换路由重派一次（决定 0093）', { timeout: 90_000 }, () => {
  it('被引擎在时限上叫停（aborted）两次判停下：先避开这个模型重派一次，不报警', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      segment: async (_i, n) =>
        n <= 2
          ? {
              ok: false,
              runId: null,
              outcome: 'failed',
              evidence: { code: 'aborted', message: '引擎叫停（60 分钟到了）', quotaExhausted: false },
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
    expect(calls.segment).toHaveLength(3);
    expect(calls.segment[2]?.route.modelId).toBe('m2');
    expect(world.alerts.filter((a) => a.level !== 'info')).toEqual([]);
    expect(world.states.some((s) => s.doing.includes('自动换一条路由重派一次'))).toBe(true);
  });

  it('【故意造出的失败】换了路由还是起不来：再判停下就真停下等人', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      segment: async () => ({
        ok: false,
        runId: null,
        outcome: 'failed',
        evidence: { code: 'spawn_failed', message: '没起来：桥接连 Mirasim 超时', quotaExhausted: false },
      }),
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        // 自动重派、自动重查之前要隔一会儿（决定 0093）：只查状态时测试服务端不跳时间，这里把时间拨过去
        await env.sleep('10 minutes');
        await statusUntil(h, parked, '换路由后还起不来，停下');
        const models = calls.segment.map((s) => s.route.modelId);
        expect(models).toContain('m1');
        expect(models).toContain('m2');
        await h.terminate('测完了');
      },
      { tasks },
    );
  });

  it('只有人能修的（没权限）：不自动重派，当场停下', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      segment: async () => ({
        ok: false,
        runId: null,
        outcome: 'failed',
        evidence: { code: 'permission_denied', message: '没有权限', quotaExhausted: false },
      }),
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(h, parked, '没权限，停下');
        expect(calls.segment).toHaveLength(1);
        await h.terminate('测完了');
      },
      { tasks },
    );
  });
});

describe('推的时候空交付：先再派一轮（决定 0093）', { timeout: 90_000 }, () => {
  it('第一次推报空交付：不停下，返工意见要 git commit，第 2 轮推上去照常合并', async () => {
    const world = createFakeWorld({
      push: (_i, n) =>
        n === 1
          ? new PortError('EMPTY_DELIVERY', '起会话前的头 abc1234 之后没有新提交', { retryable: false })
          : undefined,
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
    expect(calls.segment[1]?.feedback.join('\n')).toContain('git commit');
    expect(world.states.some((s) => s.doing.includes('空交付'))).toBe(true);
  });

  it('【故意造出的失败】再派一轮还是空交付：这回停下等人', async () => {
    const world = createFakeWorld({
      push: () =>
        new PortError('EMPTY_DELIVERY', '起会话前的头 abc1234 之后没有新提交', { retryable: false }),
    });
    const { tasks, calls } = scripted();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await statusUntil(h, parked, '第二次空交付停下');
        expect(calls.segment).toHaveLength(2);
        await h.terminate('测完了');
      },
      { tasks },
    );
  });
});

describe('CI 的结果没查成：先自己重查（决定 0093）', { timeout: 90_000 }, () => {
  it('没查成一次、重查就绿：不停下，进度写自动重查', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n === 1 ? { state: 'unknown', detail: '超时读不到' } : undefined),
    });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('waitCi')).toBe(2);
    expect(world.alerts).toEqual([]);
    expect(world.states.some((s) => s.doing.includes('自动重查'))).toBe(true);
  });

  it('【故意造出的失败】重查满了还没查成：停下等人', async () => {
    const world = createFakeWorld({ ci: () => ({ state: 'unknown', detail: '超时读不到' }) });
    const { tasks } = scripted();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        // 自动重派、自动重查之前要隔一会儿（决定 0093）：只查状态时测试服务端不跳时间，这里把时间拨过去
        await env.sleep('10 minutes');
        const s = await statusUntil(h, parked, '重查满了停下');
        expect(s.lastProblem).toBe('CI 的结果没查成');
        expect(world.count('waitCi')).toBe(CI_UNKNOWN_RECHECKS + 1);
        await h.terminate('测完了');
      },
      { tasks },
    );
  });
});

describe('冷验收和等 CI 同时起（决定 0093）', { timeout: 90_000 }, () => {
  it('CI 还挂着时验收已经起了；两样都过才挂自动合并', async () => {
    const world = createFakeWorld({ holdPorts: ['waitCi'] });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitUntil(() => calls.verify.length === 1, '验收在 CI 出结果之前就起了');
        expect(calls.arm).toBe(0);
        world.releasePort('waitCi');
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.verify).toHaveLength(1);
    expect(calls.order.indexOf('verify')).toBeLessThan(calls.order.indexOf('arm'));
  });

  it('CI 红了：验收的结果丢掉，验收轮数不算；下一轮的验收还是第 1 轮', async () => {
    const world = createFakeWorld({ ci: (_i, n) => (n === 1 ? RED : undefined) });
    const { tasks, calls } = scripted({
      // 第 1 次（和红 CI 同时跑的那次）判没过：结果该被丢掉，不进返工意见
      verify: (_i, n) =>
        n === 1
          ? { pass: false, problems: ['不该出现在返工意见里'], round: 1 }
          : { pass: true, problems: [], round: 1 },
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
    const fb = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(fb).toContain('FAIL a.test.ts');
    expect(fb).not.toContain('不该出现在返工意见里');
    expect(calls.verify.at(-1)?.round).toBe(1);
  });

  it('CI 绿、验收没过：照常返工，验收意见进下一轮', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      verify: (_i, n) =>
        n === 1
          ? { pass: false, problems: ['页面上看不到「验收中」'], round: 1 }
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
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.segment[1]?.feedback.join('\n')).toContain('页面上看不到「验收中」');
  });

  it('等 CI 时引擎自己并主线换了头：验的旧头不算、不报人，对新头再验一次', async () => {
    const world = createFakeWorld({
      ci: (_i, n) => (n === 1 ? { state: 'conflict' } : undefined),
      sync: () => ({ state: 'clean', head: 'e'.repeat(40) }),
    });
    const { tasks, calls } = scripted({
      verify: (i) =>
        i.headSha === 'e'.repeat(40)
          ? { pass: true, problems: [], round: 1 }
          : { pass: true, problems: [], round: 1, headMoved: 'e'.repeat(40) },
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
    expect(calls.verify.at(-1)?.headSha).toBe('e'.repeat(40));
    expect(world.alerts).toEqual([]);
  });
});
