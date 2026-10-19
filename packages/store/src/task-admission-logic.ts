import { createHash } from 'node:crypto';
import { AuditEntrySchema, type Task } from '@fleet-dao/shared';
import { MAX_TASK_GENERATION } from '@fleet-dao/shared/task-redo';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { NewAuditEntry } from './ports.ts';
import type { ExecutionAudit, LegacyExecutionIdentityV1, ManagedTaskBirthV1 } from './task-execution.ts';
import { canonicalExecutionUuid } from './task-execution-logic.ts';

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const executionInputHash = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** 完整 JSON 确定化；不截断正文、不丢数组次序，不允许 JSON 隐式丢值。 */
export function canonicalExecutionInput(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('执行输入数组含空洞或附加属性');
    return `[${value.map(canonicalExecutionInput).join(',')}]`;
  }
  if (object(value) && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalExecutionInput(value[k])}`)
      .join(',')}}`;
  throw new Error('执行输入不是完整 JSON');
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('|') === keys.sort().join('|');
}
export function birthCanonical(input: ManagedTaskBirthV1): string | null {
  if (!object(input) || !object(input.task)) return null;
  if (
    !exactKeys(input, [
      'protocolVersion',
      'birthRequestId',
      'coverageEpoch',
      'task',
      'namespace',
      'workflowType',
      'taskQueue',
    ]) ||
    !exactKeys(input.task, ['id', 'repoId', 'issueNumber', 'title', 'rawRequest', 'requestedBy'])
  )
    return null;
  if (
    input.protocolVersion !== 1 ||
    input.workflowType !== 'taskWorkflow' ||
    ![input.birthRequestId, input.coverageEpoch, input.task.id, input.task.repoId].every(
      canonicalExecutionUuid,
    ) ||
    ![input.namespace, input.taskQueue].every(nonempty) ||
    !Number.isInteger(input.task.issueNumber) ||
    input.task.issueNumber < 1 ||
    input.task.issueNumber > 2147483647 ||
    ![input.task.title, input.task.rawRequest, input.task.requestedBy].every((v) => typeof v === 'string')
  )
    return null;
  return canonicalExecutionInput(input);
}
export function validLegacyIdentity(input: LegacyExecutionIdentityV1): boolean {
  if (
    !object(input) ||
    input.schemaVersion !== 1 ||
    input.workflowType !== 'taskWorkflow' ||
    ![input.taskId, input.runId].every(canonicalExecutionUuid) ||
    ![input.namespace, input.workflowId, input.taskQueue].every(nonempty) ||
    !Number.isInteger(input.generation) ||
    input.generation < 1 ||
    input.generation > MAX_TASK_GENERATION ||
    typeof input.inputCanonical !== 'string' ||
    typeof input.inputHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.inputHash)
  )
    return false;
  try {
    const decoded: unknown = JSON.parse(input.inputCanonical);
    return (
      object(decoded) &&
      canonicalExecutionInput(decoded) === input.inputCanonical &&
      executionInputHash(input.inputCanonical) === input.inputHash
    );
  } catch {
    return false;
  }
}
/** 只核候选数据一致性，不证明 Temporal 来源。仓归属认持久 repoId；历史名称只绑定精确 workflowId，不按改名后的仓或任务镜像重算。 */
export function legacyMatchesTask(
  input: LegacyExecutionIdentityV1,
  task: Pick<Task, 'id' | 'repoId' | 'issueNumber'>,
): boolean {
  const decoded: unknown = JSON.parse(input.inputCanonical);
  if (!object(decoded) || !object(decoded.repo)) return false;
  return (
    decoded.schemaVersion === 1 &&
    typeof decoded.title === 'string' &&
    decoded.taskId === task.id &&
    decoded.repo.id === task.repoId &&
    decoded.issueNumber === task.issueNumber &&
    nonempty(decoded.repo.owner) &&
    nonempty(decoded.repo.name) &&
    (decoded.generation === undefined || decoded.generation === input.generation) &&
    input.workflowId ===
      taskWorkflowId(
        { owner: decoded.repo.owner, name: decoded.repo.name },
        task.issueNumber,
        input.generation,
      )
  );
}
const legacyKeys = [
  'schemaVersion',
  'taskId',
  'namespace',
  'workflowId',
  'runId',
  'workflowType',
  'taskQueue',
  'generation',
  'inputCanonical',
  'inputHash',
] as const;
export const sameLegacyIdentity = (a: LegacyExecutionIdentityV1, b: LegacyExecutionIdentityV1): boolean =>
  legacyKeys.every((k) => a[k] === b[k]);
export function admissionAudit(
  action: 'birth' | 'legacy_admit',
  taskId: string,
  after: Record<string, unknown>,
  audit: ExecutionAudit,
  at: string,
): NewAuditEntry {
  const entry: NewAuditEntry = {
    actor: audit.actor,
    via: audit.via,
    reason: audit.reason,
    action: `task_execution.${action}`,
    target: `task:${taskId}`,
    after,
    ok: true,
  };
  AuditEntrySchema.parse({ ...entry, id: '1', at });
  return entry;
}
