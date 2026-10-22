import type { MemoryData } from './memory-store.ts';
import { memoryTaskAdmission } from './task-admission-memory.ts';
import type { ExecutionAudit, ExecutionRead, ExecutionResult, TaskExecutionStore } from './task-execution.ts';
import {
  canonicalExecutionUuid,
  type ExecutionAction,
  type ExecutionInput,
  planExecution,
  validExecutionIdentity,
} from './task-execution-logic.ts';

export function memoryTaskExecution(
  data: MemoryData,
  now: () => Date,
  nextId: () => string,
  notify: (id: string) => void,
  admissionNotify: (table: 'tasks' | 'audit_log', id: string) => void,
): TaskExecutionStore {
  const read = (taskId: string): ExecutionRead => {
    if (!canonicalExecutionUuid(taskId) || !data.tasks.some((t) => t.id === taskId))
      return { kind: 'not_found' };
    const control = data.executionControls.get(taskId);
    if (!control) return { kind: 'unmanaged' };
    const current = control.currentOperationId
      ? data.executionOperations.get(control.currentOperationId)
      : null;
    if (control.currentOperationId && !current) throw new Error('执行资格当前指针缺少操作记录');
    return { kind: 'managed', control, current: current ?? null };
  };
  const mutate = async (
    action: ExecutionAction,
    input: ExecutionInput,
    audit: ExecutionAudit,
  ): Promise<ExecutionResult> => {
    if (!validExecutionIdentity(input)) return { kind: 'rejected', reason: 'invalid_identity' };
    const state = read(input.taskId);
    if (state.kind !== 'managed') return { kind: 'rejected', reason: state.kind };
    const matches = [...data.executionOperations.values()].filter(
      (o) =>
        o.operationId === input.operationId || (o.taskId === input.taskId && o.requestId === input.requestId),
    );
    if (matches.length > 1) return { kind: 'rejected', reason: 'identity_conflict' };
    const at = now().toISOString();
    const plan = planExecution(action, input, state, matches[0] ?? null, audit, at);
    if (plan.change) {
      // plan已校验全部身份、审计和快照；同步提交后才通知，返回值始终是副本。
      const change = structuredClone(plan.change);
      const id = nextId();
      data.executionOperations.set(input.operationId, change.operation);
      data.executionControls.set(input.taskId, change.control);
      data.audit.push({ ...change.audit, id, at });
      notify(id);
    }
    return structuredClone(plan.result);
  };
  return {
    ...memoryTaskAdmission(data, now, nextId, admissionNotify),
    getExecutionControl: async (taskId) => structuredClone(read(taskId)),
    reserveExecution: (input, audit) => mutate('reserve', input, audit),
    dispatchExecution: (input, audit) => mutate('dispatch', input, audit),
    admitExecution: (input, audit) => mutate('admit', input, audit),
    resolveExecution: (input, audit) => mutate('resolve', input, audit),
    closeExecutionRun: (input, audit) => mutate('close', input, audit),
  };
}
