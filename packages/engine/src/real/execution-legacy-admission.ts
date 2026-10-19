// 尚未接入生产：从当前 Local Activity 的真实来源登记 legacy 责任，不转换 Workflow 失败、不释放责任。
import { MAX_TASK_GENERATION } from '@fleet-dao/shared/task-redo';
import { parseTaskWorkflowId, taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import {
  type AdmissionWarning,
  canonicalExecutionInput,
  type ExecutionAudit,
  executionInputHash,
  isUuid,
  type LegacyAdmissionResult,
  type LegacyExecutionIdentityV1,
  type TaskExecutionStore,
} from '@fleet-dao/store';
import { Context } from '@temporalio/activity';
import {
  type ExecutionHistoryConnection,
  type ExecutionStartRead,
  executionStartReader,
  type ObservedExecution,
} from './execution-start-reader.ts';

type StartFailure = Extract<ExecutionStartRead, { kind: 'unknown' }>['code'];
type StoreRejection = Extract<LegacyAdmissionResult, { kind: 'rejected' }>['reason'];
export type LegacySourceAdmission =
  | {
      kind: 'allowed';
      status: 'admitted' | 'replayed';
      admissionId: string;
      postCommitWarnings: readonly AdmissionWarning[];
    }
  | {
      kind: 'denied';
      code: StoreRejection | 'invalid_start_input' | 'start_identity_conflict' | 'managed_start_unsupported';
    }
  | {
      kind: 'unknown';
      code:
        | 'missing_context'
        | 'invalid_activity_context'
        | 'cancelled'
        | 'unsupported_schema'
        | 'canonical_failed'
        | 'store_unavailable'
        | `start_${StartFailure}`;
    };

interface LegacyAdmissionDeps {
  connection: ExecutionHistoryConnection;
  store: Pick<TaskExecutionStore, 'admitLegacyExecution'>;
  namespace: string;
  taskQueue: string;
  audit: ExecutionAudit;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && isUuid(value) && value === value.toLowerCase();
const cancelled = (): LegacySourceAdmission => ({ kind: 'unknown', code: 'cancelled' });

function legacyCandidate(
  input: Record<string, unknown>,
  observed: ObservedExecution,
): LegacyExecutionIdentityV1 | LegacySourceAdmission {
  // 保留字段只要存在就不能降格为 legacy；null、未知版本和复制来的 opId 同样不证明 managed 来源。
  if (Object.hasOwn(input, 'execution')) return { kind: 'denied', code: 'managed_start_unsupported' };
  if (input.schemaVersion !== 1) return { kind: 'unknown', code: 'unsupported_schema' };
  const repo = input.repo;
  if (
    !uuid(input.taskId) ||
    !object(repo) ||
    !uuid(repo.id) ||
    !nonempty(repo.owner) ||
    !nonempty(repo.name) ||
    !nonempty(repo.defaultBranch) ||
    typeof repo.testCommand !== 'string' ||
    !Number.isInteger(input.issueNumber) ||
    (input.issueNumber as number) < 1 ||
    (input.issueNumber as number) > 2147483647 ||
    typeof input.title !== 'string'
  )
    return { kind: 'denied', code: 'invalid_start_input' };
  const parsed = parseTaskWorkflowId(observed.workflowId);
  if (
    !parsed ||
    parsed.generation > MAX_TASK_GENERATION ||
    (Object.hasOwn(input, 'generation') && input.generation !== parsed.generation) ||
    taskWorkflowId({ owner: repo.owner, name: repo.name }, input.issueNumber as number, parsed.generation) !==
      observed.workflowId
  )
    return { kind: 'denied', code: 'start_identity_conflict' };
  try {
    // 使用完整原始对象，不按当前 task.title/repo.profile 重建或裁掉额外业务字段。
    const inputCanonical = canonicalExecutionInput(input);
    return {
      schemaVersion: 1,
      taskId: input.taskId,
      namespace: observed.namespace,
      workflowId: observed.workflowId,
      runId: observed.runId,
      taskQueue: observed.taskQueue,
      workflowType: 'taskWorkflow',
      generation: parsed.generation,
      inputCanonical,
      inputHash: executionInputHash(inputCanonical),
    };
  } catch {
    return { kind: 'unknown', code: 'canonical_failed' };
  }
}

/** 只接受可信宿主依赖；返回无参入口，调用者不能提供 Context、observed 或 Start DTO 冒充来源。 */
export function createLegacyExecutionAdmission(
  deps: LegacyAdmissionDeps,
): () => Promise<LegacySourceAdmission> {
  if (!nonempty(deps.namespace) || !nonempty(deps.taskQueue))
    throw new Error('legacy 来源配置缺少命名空间或队列');
  if (
    !Array.isArray(deps.connection.options.interceptors) ||
    deps.connection.options.interceptors.length !== 0
  )
    throw new Error('legacy 来源须使用禁默认重试的专用读取连接');
  const reader = executionStartReader(deps.connection);
  const { namespace, taskQueue, store } = deps;
  const audit = structuredClone(deps.audit);
  return async () => {
    let context: Context;
    try {
      context = Context.current();
    } catch {
      return { kind: 'unknown', code: 'missing_context' };
    }
    const { info, cancellationSignal: signal } = context;
    if (signal.aborted) return cancelled();
    if (
      !info.isLocal ||
      info.activityType !== 'decide' ||
      info.namespace !== namespace ||
      (info.workflowNamespace !== undefined && info.workflowNamespace !== namespace) ||
      info.workflowType !== 'taskWorkflow' ||
      info.taskQueue !== taskQueue ||
      !nonempty(info.workflowExecution?.workflowId) ||
      !uuid(info.workflowExecution?.runId)
    )
      return { kind: 'unknown', code: 'invalid_activity_context' };
    const observed: ObservedExecution = {
      namespace,
      taskQueue,
      workflowType: 'taskWorkflow',
      workflowId: info.workflowExecution.workflowId,
      runId: info.workflowExecution.runId,
      isLocal: true,
    };
    let start: ExecutionStartRead;
    try {
      start = await reader.read(observed, signal);
    } catch {
      return signal.aborted ? cancelled() : { kind: 'unknown', code: 'start_unavailable' };
    }
    if (signal.aborted) return cancelled();
    if (start.kind === 'unknown') {
      if (start.code === 'cancelled') return cancelled();
      if (start.code === 'identity_conflict') return { kind: 'denied', code: 'start_identity_conflict' };
      return { kind: 'unknown', code: `start_${start.code}` };
    }
    const candidate = legacyCandidate(start.input, observed);
    if ('kind' in candidate) return candidate;
    if (signal.aborted) return cancelled();
    let result: LegacyAdmissionResult;
    try {
      result = await store.admitLegacyExecution(candidate, audit);
    } catch {
      return signal.aborted ? cancelled() : { kind: 'unknown', code: 'store_unavailable' };
    }
    // Store 无 SQL 取消合同：在途请求可能迟到提交。保留那份责任，不返回 allowed、不声称回滚。
    if (signal.aborted) return cancelled();
    if (result.kind === 'rejected') return { kind: 'denied', code: result.reason };
    return {
      kind: 'allowed',
      status: result.kind,
      admissionId: result.admission.id,
      postCommitWarnings: result.postCommitWarnings,
    };
  };
}
