// 执行资格的可信终态收敛（未接生产）：按精确 run 向 Temporal 取真实关闭状态，再交 Store 做 CAS 释放。
// 只有 DescribeWorkflowExecution 对「该 namespace/workflowId/runId」返回的终态（completed/failed/cancelled/terminated/timed_out）才释放 admitted；
// 运行中、ContinuedAsNew、找不到、读失败、超时、取消、身份对不上一律不释放——TTL、owner 消失、describe 缺失都不是证明。

import type {
  ExecutionAudit,
  ExecutionIdentity,
  ExecutionResult,
  ExecutionRunTerminalStatus,
  TaskExecutionStore,
} from '@fleet-dao/store';
import {
  type Connection,
  isGrpcCancelledError,
  isGrpcDeadlineError,
  isGrpcServiceError,
} from '@temporalio/client';

export const EXECUTION_RUN_DESCRIBE_MS = 5_000;

/** temporal.api.enums.v1.WorkflowExecutionStatus 的数值（SDK 的 protobuf 枚举）。 */
const STATUS_RUNNING = 1;
const STATUS_CONTINUED_AS_NEW = 6;
const CLOSED: Readonly<Record<number, ExecutionRunTerminalStatus>> = {
  2: 'completed',
  3: 'failed',
  4: 'cancelled',
  5: 'terminated',
  7: 'timed_out',
};

type DescribeFailure =
  | 'cancelled'
  | 'deadline'
  | 'not_found'
  | 'unavailable'
  | 'identity_conflict'
  | 'unknown_status';
export type ExecutionRunTerminalRead =
  | { kind: 'closed'; terminal: ExecutionRunTerminalStatus }
  | { kind: 'running' }
  | { kind: 'continued_as_new' }
  | { kind: 'unknown'; code: DescribeFailure };

export type ExecutionRunDescribeConnection = Pick<Connection, 'withDeadline' | 'withAbortSignal'> & {
  workflowService: Pick<Connection['workflowService'], 'describeWorkflowExecution'>;
};
export interface ObservedRun {
  namespace: string;
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue: string;
}

export function executionRunTerminalReader(connection: ExecutionRunDescribeConnection): {
  read(run: ObservedRun, signal: AbortSignal): Promise<ExecutionRunTerminalRead>;
} {
  return {
    async read(run, signal) {
      if (signal.aborted) return { kind: 'unknown', code: 'cancelled' };
      const identity = { ...run };
      let response: Awaited<ReturnType<Connection['workflowService']['describeWorkflowExecution']>>;
      try {
        response = await connection.withAbortSignal(signal, () =>
          connection.withDeadline(Date.now() + EXECUTION_RUN_DESCRIBE_MS, () =>
            connection.workflowService.describeWorkflowExecution({
              namespace: identity.namespace,
              execution: { workflowId: identity.workflowId, runId: identity.runId },
            }),
          ),
        );
      } catch (error) {
        if (signal.aborted || isGrpcCancelledError(error)) return { kind: 'unknown', code: 'cancelled' };
        if (isGrpcDeadlineError(error)) return { kind: 'unknown', code: 'deadline' };
        if (isGrpcServiceError(error) && error.code === 5) return { kind: 'unknown', code: 'not_found' };
        return { kind: 'unknown', code: 'unavailable' };
      }
      if (signal.aborted) return { kind: 'unknown', code: 'cancelled' };
      const info = response.workflowExecutionInfo;
      // 返回的必须正是请求的那个 run、类型和队列；对不上不给任何背书。
      if (
        info?.execution?.workflowId !== identity.workflowId ||
        info.execution.runId !== identity.runId ||
        info.type?.name !== identity.workflowType ||
        info.taskQueue !== identity.taskQueue
      )
        return { kind: 'unknown', code: 'identity_conflict' };
      const status = Number(info.status ?? 0);
      if (status === STATUS_RUNNING) return { kind: 'running' };
      if (status === STATUS_CONTINUED_AS_NEW) return { kind: 'continued_as_new' };
      const terminal = CLOSED[status];
      return terminal ? { kind: 'closed', terminal } : { kind: 'unknown', code: 'unknown_status' };
    },
  };
}

export type ExecutionRunRelease =
  | { kind: 'released' | 'replayed'; terminal: ExecutionRunTerminalStatus }
  | { kind: 'not_closed'; status: 'running' | 'continued_as_new' }
  | { kind: 'rejected'; reason: Extract<ExecutionResult, { kind: 'rejected' }>['reason'] }
  | { kind: 'unknown'; code: DescribeFailure | 'store_unavailable' };

/** 一次释放尝试。调用方可重复调用；任何非 released/replayed 的结果都保持责任不变。 */
export function createExecutionRunRelease(deps: {
  reader: ReturnType<typeof executionRunTerminalReader>;
  store: Pick<TaskExecutionStore, 'closeExecutionRun'>;
  taskQueue: string;
  audit: ExecutionAudit;
}): (operation: ExecutionIdentity & { runId: string }, signal: AbortSignal) => Promise<ExecutionRunRelease> {
  const audit = structuredClone(deps.audit);
  return async (operation, signal) => {
    // 在第一个 await 前固定身份，RPC 期间调用方改对象也不会换 run 背书。
    const op = { ...operation };
    const read = await deps.reader.read(
      {
        namespace: op.namespace,
        workflowId: op.workflowId,
        runId: op.runId,
        workflowType: op.workflowType,
        taskQueue: deps.taskQueue,
      },
      signal,
    );
    if (read.kind === 'running' || read.kind === 'continued_as_new')
      return { kind: 'not_closed', status: read.kind };
    if (read.kind === 'unknown') return read;
    if (signal.aborted) return { kind: 'unknown', code: 'cancelled' };
    let result: ExecutionResult;
    try {
      result = await deps.store.closeExecutionRun({ ...op, terminal: read.terminal }, audit);
    } catch {
      // 事务可能已提交：未知不等于未释放，也不等于已释放，由下一次幂等调用核实。
      return { kind: 'unknown', code: 'store_unavailable' };
    }
    return result.kind === 'rejected'
      ? { kind: 'rejected', reason: result.reason }
      : { kind: result.kind === 'applied' ? 'released' : 'replayed', terminal: read.terminal };
  };
}
