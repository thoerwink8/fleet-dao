import type { ExecutionRunCloseReason } from '@fleet-dao/db';
import type { Task } from '@fleet-dao/shared';
import type { NewAuditEntry, NewIssueTask } from './ports.ts';

export type { ExecutionRunCloseReason };
/** legacy 责任绑定的操作（与 db 的 LEGACY_EXECUTION_OPERATION 同值，store 测试钉住）：新 run 首个 decide('limits')。 */
export const LEGACY_FIRST_LIMITS_OPERATION = 'legacy_first_limits';
/** 精确 run 在 Temporal 的真实关闭状态（不含仍会续跑的 ContinuedAsNew）；由可信适配层从 DescribeWorkflowExecution 取得。 */
export type ExecutionRunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'terminated' | 'timed_out';

/** 仅存储候选身份；生产可信 Start 核验和启动入口尚未接线。 */
export interface ManagedTaskBirthV1 {
  protocolVersion: 1;
  birthRequestId: string;
  coverageEpoch: string;
  task: NewIssueTask;
  namespace: string;
  workflowType: 'taskWorkflow';
  taskQueue: string;
}
export interface ExecutionBirthV1 {
  taskId: string;
  protocolVersion: 1;
  birthRequestId: string;
  coverageEpoch: string;
  namespace: string;
  workflowType: 'taskWorkflow';
  taskQueue: string;
  birthInputCanonical: string;
  birthInputHash: string;
  createdAt: string;
}
export type BirthResult =
  | {
      kind: 'created' | 'replayed';
      task: Task;
      control: ExecutionControl;
      birth: ExecutionBirthV1;
      postCommitWarnings: readonly AdmissionWarning[];
    }
  | { kind: 'rejected'; reason: 'invalid_identity' | 'existing_task_forbidden' | 'identity_conflict' };
export interface LegacyExecutionIdentityV1 {
  schemaVersion: 1;
  taskId: string;
  namespace: string;
  workflowId: string;
  runId: string;
  workflowType: 'taskWorkflow';
  taskQueue: string;
  generation: number;
  /** 责任所属操作；没有它的候选不是本合同的准入输入。 */
  operation: typeof LEGACY_FIRST_LIMITS_OPERATION;
  inputCanonical: string;
  inputHash: string;
}
/** 持久责任清单，无 TTL、owner 或终态释放入口；不是 legacy 并发限流。 */
export interface LegacyExecutionAdmissionV1 extends LegacyExecutionIdentityV1 {
  id: string;
  admittedAt: string;
}
export type LegacyAdmissionResult =
  | {
      kind: 'admitted' | 'replayed';
      admission: LegacyExecutionAdmissionV1;
      postCommitWarnings: readonly AdmissionWarning[];
    }
  | {
      kind: 'rejected';
      reason: 'not_found' | 'invalid_identity' | 'identity_conflict' | 'managed_requires_operation';
    };
/** 仅表示本层提交后通知异常；空列表不证明通知送达或旧异常已恢复。 */
export interface AdmissionWarning {
  code: 'notification_failed';
  table: 'tasks' | 'audit_log';
  id: string;
}

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
  resolvedReason: 'cancelled_before_dispatch' | ExecutionRunCloseReason | null;
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
  /** 新 task/control/birth/audit 同事务出生；已有任务永不初始化。 */
  createManagedTaskFromIssue(input: ManagedTaskBirthV1, audit: ExecutionAudit): Promise<BirthResult>;
  getExecutionBirth(taskId: string): Promise<ExecutionBirthV1 | null>;
  admitLegacyExecution(
    input: LegacyExecutionIdentityV1,
    audit: ExecutionAudit,
  ): Promise<LegacyAdmissionResult>;
  listLegacyExecutionAdmissions(taskId: string): Promise<readonly LegacyExecutionAdmissionV1[]>;
  getExecutionControl(taskId: string): Promise<ExecutionRead>;
  reserveExecution(input: ReserveExecutionInput, audit: ExecutionAudit): Promise<ExecutionResult>;
  dispatchExecution(input: ExecutionIdentity, audit: ExecutionAudit): Promise<ExecutionResult>;
  admitExecution(
    input: ExecutionIdentity & { runId: string },
    audit: ExecutionAudit,
  ): Promise<ExecutionResult>;
  /** 只撤销reserved；dispatching/admitted 只能经 closeExecutionRun 凭精确 run 的真实终态释放。 */
  resolveExecution(
    input: ExecutionIdentity & { reason: 'cancelled_before_dispatch' },
    audit: ExecutionAudit,
  ): Promise<ExecutionResult>;
  /**
   * 凭精确 run 的真实关闭状态释放 admitted：同事务 CAS（phase=admitted、admittedRunId 相等、control 当前指针/epoch/revision 不变）+ 审计。
   * dispatching 没有 run 绑定，永远 proof_required；Store 不联网，terminal 只能来自 engine 的 Temporal 终态核验器。
   */
  closeExecutionRun(
    input: ExecutionIdentity & { runId: string; terminal: ExecutionRunTerminalStatus },
    audit: ExecutionAudit,
  ): Promise<ExecutionResult>;
}

export type TaskAdmissionStore = Pick<
  TaskExecutionStore,
  | 'createManagedTaskFromIssue'
  | 'getExecutionBirth'
  | 'admitLegacyExecution'
  | 'listLegacyExecutionAdmissions'
>;
