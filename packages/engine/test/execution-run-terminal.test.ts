import type { ExecutionIdentity, ExecutionResult } from '@fleet-dao/store';
import { describe, expect, it, vi } from 'vitest';
import {
  createExecutionRunRelease,
  type ExecutionRunDescribeConnection,
  executionRunTerminalReader,
} from '../src/real/execution-run-terminal.ts';

const RUN = '11111111-2222-4333-8444-555555555555';
const run = {
  namespace: 'ns',
  workflowId: 'task:example/canary#1',
  runId: RUN,
  workflowType: 'taskWorkflow',
  taskQueue: 'q',
};
const never = new AbortController().signal;

function connection(respond: () => unknown, calls: unknown[] = []): ExecutionRunDescribeConnection {
  return {
    withDeadline: (_deadline: unknown, fn: () => unknown) => fn(),
    withAbortSignal: (_signal: unknown, fn: () => unknown) => fn(),
    workflowService: {
      describeWorkflowExecution: async (request: unknown) => {
        calls.push(request);
        return respond();
      },
    },
  } as unknown as ExecutionRunDescribeConnection;
}
const info = (status: number, over: Record<string, unknown> = {}) => ({
  workflowExecutionInfo: {
    execution: { workflowId: run.workflowId, runId: run.runId },
    type: { name: run.workflowType },
    taskQueue: run.taskQueue,
    status,
    ...over,
  },
});

describe('精确 run 的终态读取', () => {
  it.each([
    [2, 'completed'],
    [3, 'failed'],
    [4, 'cancelled'],
    [5, 'terminated'],
    [7, 'timed_out'],
  ])('状态 %s 是真实终态 %s，请求精确 namespace/workflowId/runId', async (status, terminal) => {
    const calls: unknown[] = [];
    const reader = executionRunTerminalReader(connection(() => info(status), calls));
    expect(await reader.read(run, never)).toEqual({ kind: 'closed', terminal });
    expect(calls).toEqual([{ namespace: 'ns', execution: { workflowId: run.workflowId, runId: RUN } }]);
  });

  it('运行中与 ContinuedAsNew 不是可释放终态；未知状态数值保持未知', async () => {
    expect(await executionRunTerminalReader(connection(() => info(1))).read(run, never)).toEqual({
      kind: 'running',
    });
    expect(await executionRunTerminalReader(connection(() => info(6))).read(run, never)).toEqual({
      kind: 'continued_as_new',
    });
    for (const status of [0, 8, 99])
      expect(await executionRunTerminalReader(connection(() => info(status))).read(run, never)).toEqual({
        kind: 'unknown',
        code: 'unknown_status',
      });
  });

  it('返回的 run/类型/队列/workflowId 任一对不上都不背书', async () => {
    for (const over of [
      { execution: { workflowId: run.workflowId, runId: '99999999-2222-4333-8444-555555555555' } },
      { execution: { workflowId: 'task:example/canary#2', runId: RUN } },
      { type: { name: 'other' } },
      { taskQueue: 'other' },
    ])
      expect(await executionRunTerminalReader(connection(() => info(2, over))).read(run, never)).toEqual({
        kind: 'unknown',
        code: 'identity_conflict',
      });
    expect(await executionRunTerminalReader(connection(() => ({}))).read(run, never)).toEqual({
      kind: 'unknown',
      code: 'identity_conflict',
    });
  });

  it('找不到、读失败、取消、预取消各自明确，绝不当成终态', async () => {
    const fail = (error: unknown) =>
      executionRunTerminalReader(
        connection(() => {
          throw error;
        }),
      ).read(run, never);
    expect(
      await fail(Object.assign(new Error('nf'), { code: 5, details: 'not found', metadata: {} })),
    ).toEqual({
      kind: 'unknown',
      code: 'not_found',
    });
    expect(await fail(new Error('boom'))).toEqual({ kind: 'unknown', code: 'unavailable' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await executionRunTerminalReader(connection(() => info(2))).read(run, aborted.signal)).toEqual({
      kind: 'unknown',
      code: 'cancelled',
    });
  });
});

describe('终态释放', () => {
  const identity = {
    taskId: '22222222-2222-4333-8444-555555555555',
    operationId: '33333333-2222-4333-8444-555555555555',
    coverageEpoch: '44444444-2222-4333-8444-555555555555',
    revision: 1,
    requestId: '55555555-2222-4333-8444-555555555555',
    nodeId: 'n',
    kind: 'start',
    namespace: run.namespace,
    workflowId: run.workflowId,
    generation: 1,
    workflowType: run.workflowType,
    inputHash: 'h',
    runId: RUN,
  } satisfies ExecutionIdentity & { runId: string };
  const audit = { actor: { kind: 'engine' as const, id: 'e' }, via: 'engine' as const };
  const setup = (respond: () => unknown, close: () => Promise<ExecutionResult>) => {
    const store = { closeExecutionRun: vi.fn(close) };
    const release = createExecutionRunRelease({
      reader: executionRunTerminalReader(connection(respond)),
      store,
      taskQueue: run.taskQueue,
      audit,
    });
    return { store, release };
  };
  const applied = { kind: 'applied', operation: {} } as unknown as ExecutionResult;

  it('只有 closed 才调 Store，且带上读到的终态和精确 run', async () => {
    const s = setup(
      () => info(3),
      async () => applied,
    );
    expect(await s.release(identity, never)).toEqual({ kind: 'released', terminal: 'failed' });
    expect(s.store.closeExecutionRun).toHaveBeenCalledWith({ ...identity, terminal: 'failed' }, audit);
    const again = setup(
      () => info(3),
      async () => ({ kind: 'replayed', operation: {} }) as never,
    );
    expect(await again.release(identity, never)).toEqual({ kind: 'replayed', terminal: 'failed' });
  });

  it('运行中、ContinuedAsNew、读不到、身份不符：Store 一次都不碰', async () => {
    for (const respond of [
      () => info(1),
      () => info(6),
      () => info(2, { taskQueue: 'x' }),
      () => {
        throw new Error('down');
      },
    ]) {
      const s = setup(respond, async () => applied);
      const result = await s.release(identity, never);
      expect(result.kind === 'released' || result.kind === 'replayed').toBe(false);
      expect(s.store.closeExecutionRun).not.toHaveBeenCalled();
    }
  });

  it('Store 拒绝原样回报；Store 抛错是未知，不声称已释放', async () => {
    const rejected = setup(
      () => info(2),
      async () => ({ kind: 'rejected', reason: 'identity_conflict' }),
    );
    expect(await rejected.release(identity, never)).toEqual({
      kind: 'rejected',
      reason: 'identity_conflict',
    });
    const down = setup(
      () => info(2),
      async () => {
        throw new Error('commit lost');
      },
    );
    expect(await down.release(identity, never)).toEqual({ kind: 'unknown', code: 'store_unavailable' });
  });

  it('RPC 期间调用方改对象不能换 run 背书；读完取消则不写', async () => {
    const mutable = { ...identity };
    const s = setup(
      () => {
        mutable.runId = '99999999-2222-4333-8444-555555555555';
        return info(2);
      },
      async () => applied,
    );
    await s.release(mutable, never);
    expect(s.store.closeExecutionRun).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN }), audit);
    const controller = new AbortController();
    const late = setup(
      () => {
        controller.abort();
        return info(2);
      },
      async () => applied,
    );
    expect(await late.release(identity, controller.signal)).toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(late.store.closeExecutionRun).not.toHaveBeenCalled();
  });
});
