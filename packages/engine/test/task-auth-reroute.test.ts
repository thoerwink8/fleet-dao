// 出在账号池上的停（登录失效、封号、设备被撤销）：池暂停并报警，这张单马上回去选路避开这个池。
// 只凭一次 HTTP 401 不暂停整池，换一条路由；同一个池再来一次才暂停。避开之后没有能派的路由，才挂起「能派的池都停了」。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, type FakeWorld } from '../src/fakes.ts';
import type { RouteChoice } from '../src/ports.ts';
import {
  type RunSegmentResult,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { POOLS_ALL_HELD } from '../src/workflows/task-support.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
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
    issueNumber: 2710,
    title: '登录失效换池',
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
const parked = (s: TaskStatus) => s.waiting?.kind === 'human';

const R1: RouteChoice = { routeId: 'r1', poolId: 'p1', modelId: 'm1', family: 'claude', hostId: 'claude-code' };
const R1B: RouteChoice = { routeId: 'r1b', poolId: 'p1', modelId: 'm1', family: 'claude', hostId: 'mirasim' };
const R2: RouteChoice = { routeId: 'r2', poolId: 'p2', modelId: 'm2', family: 'kimi', hostId: 'api-shell' };

function failed(message: string, code: string, httpStatus?: number): RunSegmentResult {
  return {
    ok: false,
    runId: null,
    outcome: 'failed',
    evidence: {
      code,
      message,
      quotaExhausted: false,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    },
  };
}

const BANNED = failed('当前绑定账号暂不可用', 'account_banned');
const UNAUTHORIZED = failed('HTTP 401 Unauthorized', 'agent_error', 401);

function holdAlerts(world: FakeWorld, poolId: string) {
  return world.alerts.filter((a) => a.dedupeKey === `pool-hold:${poolId}`);
}

describe('账号池上的停：停池、单换路（auth-reroute）', { timeout: 90_000 }, () => {
  it('封号：整池暂停并报警，这张单避开这个池派到别的池，不挂起', async () => {
    const world = createFakeWorld({ routes: [R1, R2] });
    const { tasks, calls } = scripted({
      segment: async (_input, n) => (n === 1 ? BANNED : OK_SEGMENT),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged' });
    expect(calls.segment.map((s) => s.route.poolId)).toEqual(['p1', 'p2']);
    const picks = world.callsOf('pickRoute');
    expect(picks[1]?.input.avoidPoolIds).toContain('p1');
    const holds = holdAlerts(world, 'p1');
    expect(holds).toHaveLength(1);
    expect(holds[0]?.level).toBe('decision');
    expect(holds[0]?.title).toContain('账号被封');
    expect(holds[0]?.detail).toContain('整池暂停');
    expect(world.states.some((s) => s.phase === 'parked')).toBe(false);
  });

  it('同一个池连续两次 401 才整池暂停；第一次只换路由，然后派到别的池', async () => {
    const world = createFakeWorld({ routes: [R1, R1B, R2] });
    const { tasks, calls } = scripted({
      segment: async (seg) => (seg.route.poolId === 'p1' ? UNAUTHORIZED : OK_SEGMENT),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged' });
    expect(calls.segment.map((s) => s.route.routeId)).toEqual(['r1', 'r1b', 'r2']);
    const picks = world.callsOf('pickRoute');
    expect(picks[1]?.input.avoidRouteIds).toContain('r1');
    expect(picks[1]?.input.avoidPoolIds).not.toContain('p1');
    expect(picks[2]?.input.avoidPoolIds).toContain('p1');
    const holds = holdAlerts(world, 'p1');
    expect(holds).toHaveLength(1);
    expect(holds[0]?.detail).toContain('第二次 401');
    expect(world.states.some((s) => s.phase === 'parked')).toBe(false);
  });

  it('避开停着的池之后没有能派的路由：挂起，原因写明能派的池都停了', async () => {
    const world = createFakeWorld({ routes: [R1] });
    const { tasks, calls } = scripted({
      segment: async () => BANNED,
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await pollQuery(() => statusOf(h), parked, '能派的池都停了');
        expect(s.lastProblem).toBe(POOLS_ALL_HELD);
        expect(calls.segment).toHaveLength(1);
        expect(holdAlerts(world, 'p1')).toHaveLength(1);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        return h.result();
      },
      { tasks },
    );
  });

  it('只有一条路由时，第一次 401 原路再试，第二次才停池并挂起', async () => {
    const world = createFakeWorld({ routes: [R1] });
    const { tasks, calls } = scripted({
      segment: async () => UNAUTHORIZED,
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await pollQuery(() => statusOf(h), parked, '两次 401 之后能派的池都停了');
        expect(s.lastProblem).toBe(POOLS_ALL_HELD);
        expect(calls.segment).toHaveLength(2);
        expect(calls.segment.every((seg) => seg.route.routeId === 'r1')).toBe(true);
        const picks = world.callsOf('pickRoute');
        expect(picks[1]?.input.avoidRouteIds).toContain('r1');
        expect(picks[1]?.input.avoidPoolIds).not.toContain('p1');
        expect(picks.at(-1)?.input.avoidPoolIds).toContain('p1');
        const holds = holdAlerts(world, 'p1');
        expect(holds).toHaveLength(1);
        expect(holds[0]?.detail).toContain('第二次 401');
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        return h.result();
      },
      { tasks },
    );
  });
});
