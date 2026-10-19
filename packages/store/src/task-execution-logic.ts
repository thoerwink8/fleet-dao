import { AuditEntrySchema } from '@fleet-dao/shared';
import { MAX_TASK_GENERATION } from '@fleet-dao/shared/task-redo';
import { isUuid } from './ids.ts';
import type { NewAuditEntry } from './ports.ts';
import type {
  ExecutionAudit,
  ExecutionControl,
  ExecutionIdentity,
  ExecutionOperation,
  ExecutionRead,
  ExecutionResult,
  ReserveExecutionInput,
} from './task-execution.ts';

export type ExecutionAction = 'reserve' | 'dispatch' | 'admit' | 'resolve';
export type ExecutionInput = ExecutionIdentity & {
  expectedRevision?: number;
  runId?: string;
  reason?: string;
};
export interface ExecutionPlan {
  result: ExecutionResult;
  change?: { control: ExecutionControl; operation: ExecutionOperation; audit: NewAuditEntry };
}
const reject = (reason: Extract<ExecutionResult, { kind: 'rejected' }>['reason']): ExecutionPlan => ({
  result: { kind: 'rejected', reason },
});
const keys = [
  'taskId',
  'operationId',
  'coverageEpoch',
  'revision',
  'requestId',
  'nodeId',
  'kind',
  'namespace',
  'workflowId',
  'generation',
  'workflowType',
  'inputHash',
] as const;
export const sameExecutionIdentity = (a: ExecutionIdentity, b: ExecutionIdentity): boolean =>
  keys.every((k) => a[k] === b[k]);
export const canonicalExecutionUuid = (value: unknown): value is string =>
  typeof value === 'string' && value === value.toLowerCase() && isUuid(value);
export function validExecutionIdentity(input: ExecutionIdentity): boolean {
  return (
    ['taskId', 'operationId', 'coverageEpoch', 'requestId'].every((k) =>
      canonicalExecutionUuid(Reflect.get(input, k)),
    ) &&
    Number.isInteger(input.generation) &&
    input.generation >= 1 &&
    input.generation <= MAX_TASK_GENERATION &&
    Number.isSafeInteger(input.revision) &&
    input.revision > 0 &&
    ['nodeId', 'namespace', 'workflowId', 'workflowType', 'inputHash'].every(
      (k) => typeof Reflect.get(input, k) === 'string' && Reflect.get(input, k).trim().length > 0,
    ) &&
    (input.kind === 'start' || input.kind === 'redo')
  );
}

/** 纯判断；时间仅记事实，绝不用于收回未知执行责任。 */
export function planExecution(
  action: ExecutionAction,
  input: ExecutionInput,
  read: ExecutionRead,
  existing: ExecutionOperation | null,
  audit: ExecutionAudit,
  at: string,
): ExecutionPlan {
  if (!validExecutionIdentity(input)) return reject('invalid_identity');
  if (
    action === 'reserve' &&
    (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== input.revision - 1)
  )
    return reject('invalid_identity');
  if (read.kind !== 'managed') return reject(read.kind);
  const control = read.control;
  if (existing && !sameExecutionIdentity(existing, input)) return reject('identity_conflict');
  if (action === 'reserve' && existing) return { result: { kind: 'replayed', operation: existing } };
  if (action === 'resolve' && existing?.phase === 'resolved' && input.reason === 'cancelled_before_dispatch')
    return { result: { kind: 'replayed', operation: existing } };
  if (control.coverageEpoch !== input.coverageEpoch) return reject('stale');
  let operation: ExecutionOperation;
  if (action === 'reserve') {
    const reserve = input as ReserveExecutionInput;
    if (!Number.isSafeInteger(reserve.expectedRevision) || reserve.expectedRevision < 0)
      return reject('invalid_identity');
    if (control.revision === Number.MAX_SAFE_INTEGER) return reject('revision_exhausted');
    if (control.revision !== reserve.expectedRevision || input.revision !== control.revision + 1)
      return reject('stale');
    if (control.currentOperationId !== null) return reject('busy');
    operation = {
      ...(Object.fromEntries(keys.map((k) => [k, input[k]])) as unknown as ExecutionIdentity),
      phase: 'reserved',
      admittedRunId: null,
      resolvedReason: null,
      createdAt: at,
      updatedAt: at,
      dispatchedAt: null,
      admittedAt: null,
      resolvedAt: null,
    };
  } else {
    if (!existing) return reject('stale');
    if (control.currentOperationId !== input.operationId || control.revision !== input.revision)
      return reject('stale');
    if (action === 'dispatch') {
      if (existing.phase === 'dispatching' || existing.phase === 'admitted')
        return { result: { kind: 'replayed', operation: existing } };
      if (existing.phase !== 'reserved') return reject('phase_conflict');
      operation = { ...existing, phase: 'dispatching', updatedAt: at, dispatchedAt: at };
    } else if (action === 'admit') {
      if (typeof input.runId !== 'string' || !input.runId.trim()) return reject('invalid_identity');
      if (existing.phase === 'admitted')
        return existing.admittedRunId === input.runId
          ? { result: { kind: 'replayed', operation: existing } }
          : reject('identity_conflict');
      if (existing.phase !== 'dispatching') return reject('phase_conflict');
      operation = {
        ...existing,
        phase: 'admitted',
        admittedRunId: input.runId,
        admittedAt: at,
        updatedAt: at,
      };
    } else {
      if (existing.phase === 'dispatching' || existing.phase === 'admitted') return reject('proof_required');
      if (input.reason !== 'cancelled_before_dispatch' || existing.phase !== 'reserved')
        return reject('phase_conflict');
      operation = {
        ...existing,
        phase: 'resolved',
        resolvedReason: 'cancelled_before_dispatch',
        resolvedAt: at,
        updatedAt: at,
      };
    }
  }
  const nextControl: ExecutionControl = {
    ...control,
    revision: operation.revision,
    currentOperationId: operation.phase === 'resolved' ? null : operation.operationId,
  };
  const entry: NewAuditEntry = {
    actor: audit.actor,
    via: audit.via,
    reason: audit.reason,
    action: `task_execution.${action}`,
    target: `task:${input.taskId}`,
    before: existing,
    after: operation,
    ok: true,
  };
  AuditEntrySchema.parse({ ...entry, id: '1', at });
  return {
    result: { kind: 'applied', operation },
    change: { control: nextControl, operation, audit: entry },
  };
}
