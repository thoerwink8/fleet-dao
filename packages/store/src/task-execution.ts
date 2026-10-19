import type { NewAuditEntry } from './ports.ts';

/** 未接生产入口的资格内核；调用方提供的run身份还须由后续可信适配层核验。 */
export interface ExecutionIdentity {
  /** UUID字段只收规范小写，避免Memory字串比较与PG UUID归一化分歧。 */
  taskId: string;
  operationId: string;
  coverageEpoch: string;
  revision: number;
  requestId: string;
  nodeId: string;
  kind: 'start' | 'redo';
  namespace: string;
  workflowId: string;
  generation: number;
  workflowType: string;
  inputHash: string;
}
export interface ExecutionOperation extends ExecutionIdentity {
  phase: 'reserved' | 'dispatching' | 'admitted' | 'resolved';
  admittedRunId: string | null;
  resolvedReason: 'cancelled_before_dispatch' | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  admittedAt: string | null;
  resolvedAt: string | null;
}
export interface ExecutionControl {
  taskId: string;
  protocolVersion: 1;
  coverageEpoch: string;
  revision: number;
  currentOperationId: string | null;
}
export type ExecutionRead =
  | { kind: 'not_found' | 'unmanaged' }
  | {
      kind: 'managed';
      control: ExecutionControl;
      current: ExecutionOperation | null;
    };
export type ExecutionResult =
  | {
      kind: 'applied' | 'replayed';
      operation: ExecutionOperation;
    }
  | {
      kind: 'rejected';
      reason:
        | 'not_found'
        | 'unmanaged'
        | 'invalid_identity'
        | 'identity_conflict'
        | 'stale'
        | 'busy'
        | 'phase_conflict'
        | 'proof_required'
        | 'revision_exhausted';
    };
export type ExecutionAudit = Pick<NewAuditEntry, 'actor' | 'via' | 'reason'>;
export interface ReserveExecutionInput extends ExecutionIdentity {
  expectedRevision: number;
}
export interface TaskExecutionStore {
  getExecutionControl(taskId: string): Promise<ExecutionRead>;
  reserveExecution(input: ReserveExecutionInput, audit: ExecutionAudit): Promise<ExecutionResult>;
  dispatchExecution(input: ExecutionIdentity, audit: ExecutionAudit): Promise<ExecutionResult>;
  admitExecution(
    input: ExecutionIdentity & { runId: string },
    audit: ExecutionAudit,
  ): Promise<ExecutionResult>;
  /** 本片只撤销reserved；dispatching/admitted没有可信终态释放口。 */
  resolveExecution(
    input: ExecutionIdentity & { reason: 'cancelled_before_dispatch' },
    audit: ExecutionAudit,
  ): Promise<ExecutionResult>;
}
