// 受管仓的 CI 模式（patched('repo-ci-policy')）：不强制时跳过等 CI 和冷验收，直接合并；
// 强制但没配检查时停下，写明原因。模式在等 CI 之前现读，停在「没配检查」上的单切成不强制后自己接着走。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, type FakeScript } from '../src/fakes.ts';
import type { TaskRun, TaskStatus, TaskWorkflowInput } from '../src/task-contract.ts';
import { taskAbandonSignal, taskStatusQuery } from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const SKIP = '这个仓不强制 CI：交活前自己跑通（能起来，碰界面的贴截图）。引擎这一路不设 CI 和冷验收闸门。';
const NO_CHECKS = '这个仓是强制 CI，但没配检查';

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

const noChecks: FakeScript['ci'] = () => ({
  state: 'unknown',
  detail: 'CI 根本没跑：这个仓一个检查都没有',
});

describe('任务工作流 · 按仓的 CI 模式', { timeout: 60_000 }, () => {
  it('不强制 CI：一路走到合并，不调用 waitCi、也不做冷验收', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({ ciPolicy: () => ({ mode: 'off' }) });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('waitCi')).toBe(0);
    expect(calls.verify).toEqual([]);
    expect(calls.arm).toBe(0);
    expect(calls.merge).toBe(1);
    expect(calls.order).toEqual(['brief', 'segment', 'delivery', 'guarded']);
    expect(calls.segment[0]?.feedback).toEqual([SKIP]);
  });

  it('不强制 CI 碰到改标准路径：照样停下等人，不直接合并', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      ciPolicy: () => ({ mode: 'off' }),
      guarded: () => ({ standards: ['AGENTS.md（通用段）'] }),
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '改标准，停下等创始人');
        expect(s.waiting?.detail).toContain('标准路径');
        expect(calls.verify).toEqual([]);
        expect(calls.arm).toBe(0);
        expect(calls.merge).toBe(0);
        expect(world.count('waitCi')).toBe(0);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '这张先不做' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(calls.merge).toBe(0);
    expect(calls.arm).toBe(0);
  });

  it('停在等 CI（没配检查）时把仓切成不强制：不用人点继续，自己走到合并', async () => {
    let mode: 'force' | 'off' = 'force';
    const world = createFakeWorld({ ci: noChecks });
    const { tasks, calls } = scripted({ ciPolicy: () => ({ mode }) });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '没配检查，停下');
        expect(s.lastProblem).toContain(NO_CHECKS);
        // 和等 CI 同时起的那一次验收（决定 0093）可能已经调了，但结果没被认
        expect(calls.verify.length).toBeLessThanOrEqual(1);
        expect(calls.merge).toBe(0);
        mode = 'off';
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('waitCi')).toBe(1);
    expect(calls.verify.length).toBeLessThanOrEqual(1);
    expect(calls.arm).toBe(0);
    expect(calls.merge).toBe(1);
  });

  it('强制 CI 的仓没有检查：停下，提示写明这个仓是强制 CI 但没配检查', async () => {
    const world = createFakeWorld({ ci: noChecks });
    const { tasks } = scripted();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parked, '没配检查，停下');
        expect(s.lastProblem).toContain(NO_CHECKS);
        expect(s.waiting?.detail).toContain(NO_CHECKS);
        expect(world.alerts[0]?.title).toContain(NO_CHECKS);
        expect(world.alerts[0]?.detail).toContain(NO_CHECKS);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '先不修检查' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
  });

  it('停在「CI 没查成」时把仓切成不强制：不用人点继续，自己走到合并', async () => {
    let mode: 'force' | 'off' = 'force';
    const world = createFakeWorld({
      ci: () => ({ state: 'unknown', detail: 'CI 没查成：GitHub 超时' }),
    });
    const { tasks, calls } = scripted({ ciPolicy: () => ({ mode }) });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        // 自动重派、自动重查之前要隔一会儿（决定 0093）：只查状态时测试服务端不跳时间，这里把时间拨过去
        await env.sleep('10 minutes');
        const s = await statusUntil(h, parked, 'CI 没查成，停下');
        expect(s.lastProblem).toBe('CI 的结果没查成');
        expect(s.lastProblem ?? '').not.toContain(NO_CHECKS);
        mode = 'off';
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    // 和等 CI 同时起的那一次验收（决定 0093）可能已经调了，但结果没被认：最多那一次，验收轮数没加
    expect(calls.verify.length).toBeLessThanOrEqual(1);
    expect(calls.merge).toBe(1);
  });

  it('强制 CI 读失败（不是没配检查）：仍按「没查成」停下，不写成没配检查', async () => {
    const world = createFakeWorld({
      ci: () => ({ state: 'unknown', detail: 'CI 没查成：GitHub 超时' }),
    });
    const { tasks } = scripted();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        // 自动重派、自动重查之前要隔一会儿（决定 0093）：只查状态时测试服务端不跳时间，这里把时间拨过去
        await env.sleep('10 minutes');
        const s = await statusUntil(h, parked, 'CI 没查成，停下');
        expect(s.lastProblem).toBe('CI 的结果没查成');
        expect(s.lastProblem ?? '').not.toContain(NO_CHECKS);
        expect(world.alerts[0]?.title ?? '').not.toContain(NO_CHECKS);
        expect(world.alerts[0]?.detail).toContain('CI 没查成');
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '先停' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
  });
});
