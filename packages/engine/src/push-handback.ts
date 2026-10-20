// 只交还无 PR 的 WORKFLOWS_PERMISSION 推送停点；调用方不得提供退场事实。

import type { RequirementContract, TaskBrief } from './runner/task-brief.ts';
import type { ClosedIssueHoldToken, TaskWorkflowInput } from './task-contract.ts';

interface HandbackRequestBase {
  requestId: string;
  token: ClosedIssueHoldToken;
  by: string;
  feedback: string;
}

export type PushHandbackRequest = HandbackRequestBase &
  (
    | { version: 1 }
    | { version: 2; originalContract: RequirementContract; expectedContract: RequirementContract }
  );

export interface PushHandbackReceipt {
  version: 1 | 2;
  requestId: string;
  /** 完整规范载荷；调用方核对它，不能只认 transport Update 成功。 */
  payload: string;
  outcome: 'handed_back' | 'stale' | 'busy' | 'budget-held' | 'unknown' | 'conflict';
  code?: string;
  /** v2 成功只证明主路径接纳了该正式快照，不保证外部正文此后不变。 */
  acceptedContract?: RequirementContract;
}

interface PreflightInputBase {
  workflowId: string;
  runId: string;
  task: TaskWorkflowInput;
  branch: string;
  path: string;
  contract: RequirementContract;
  token: ClosedIssueHoldToken;
  /** 只读预算，不授予新的份数或重置轮数。 */
  budgetGrants: number;
  taskTokenBudget: number;
  round: number;
  verifyRound: number;
}

export type PushHandbackPreflightInput = PreflightInputBase &
  ({ version: 1 } | { version: 2; requestId: string; expectedContract: RequirementContract });

export type PushHandbackPreflight =
  | { outcome: 'natural-retired'; head: string; evidenceSha256: string; brief?: TaskBrief }
  | { outcome: 'unknown' | 'budget-held'; code: string };

function exact(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** 可在工作流中使用：不引入 task-brief 的 Node 实现，也不接受额外合同字段。 */
export function validHandbackContract(value: unknown): value is RequirementContract {
  if (!value || typeof value !== 'object' || !exact(value, ['version', 'sha256'])) return false;
  const contract = value as RequirementContract;
  return (
    contract.version === 1 && typeof contract.sha256 === 'string' && /^[a-f0-9]{64}$/.test(contract.sha256)
  );
}

/** 规范化前先拒绝未知字段；同业务编号异文必须到 handler 并明确冲突。 */
export function pushHandbackPayload(value: PushHandbackRequest): string {
  if (
    !value ||
    typeof value !== 'object' ||
    !exact(value, [
      'version',
      'requestId',
      'token',
      'by',
      'feedback',
      ...(value.version === 2 ? ['originalContract', 'expectedContract'] : []),
    ]) ||
    (value.version !== 1 && value.version !== 2) ||
    (value.version === 2 &&
      (!validHandbackContract(value.originalContract) || !validHandbackContract(value.expectedContract))) ||
    typeof value.requestId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.requestId) ||
    typeof value.by !== 'string' ||
    !value.by.trim() ||
    value.by.length > 200 ||
    typeof value.feedback !== 'string' ||
    !value.feedback.trim() ||
    value.feedback.length > 16_000
  )
    throw new Error('INVALID_PUSH_HANDBACK_REQUEST');
  const t = value.token;
  if (
    !t ||
    typeof t !== 'object' ||
    !exact(t, ['version', 'runId', 'kind', 'generation', 'continued']) ||
    t.version !== 1 ||
    t.kind !== 'parked' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t.runId) ||
    !Number.isSafeInteger(t.generation) ||
    t.generation < 1 ||
    !Number.isSafeInteger(t.continued) ||
    t.continued < 0
  )
    throw new Error('INVALID_PUSH_HANDBACK_TOKEN');
  return JSON.stringify({
    version: value.version,
    requestId: value.requestId,
    token: {
      version: 1,
      runId: t.runId,
      kind: t.kind,
      generation: t.generation,
      continued: t.continued,
    },
    by: value.by,
    feedback: value.feedback,
    ...(value.version === 2
      ? {
          originalContract: { version: 1, sha256: value.originalContract.sha256 },
          expectedContract: { version: 1, sha256: value.expectedContract.sha256 },
        }
      : {}),
  });
}

export function samePushHold(a: ClosedIssueHoldToken | null, b: ClosedIssueHoldToken): boolean {
  return (
    !!a &&
    a.version === b.version &&
    a.runId === b.runId &&
    a.kind === b.kind &&
    a.generation === b.generation &&
    a.continued === b.continued
  );
}
