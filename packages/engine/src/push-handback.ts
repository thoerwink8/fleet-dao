// 只交还无 PR 的 WORKFLOWS_PERMISSION 推送停点；调用方不得提供退场事实。

import type { RequirementContract } from './runner/task-brief.ts';
import type { ClosedIssueHoldToken, TaskWorkflowInput } from './task-contract.ts';

export interface PushHandbackRequest {
  version: 1;
  requestId: string;
  token: ClosedIssueHoldToken;
  by: string;
  feedback: string;
}

export interface PushHandbackReceipt {
  version: 1;
  requestId: string;
  /** 完整规范载荷；调用方核对它，不能只认 transport Update 成功。 */
  payload: string;
  outcome: 'handed_back' | 'stale' | 'busy' | 'budget-held' | 'unknown' | 'conflict';
  code?: string;
}

export interface PushHandbackPreflightInput {
  version: 1;
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

export type PushHandbackPreflight =
  | { outcome: 'natural-retired'; head: string; evidenceSha256: string }
  | { outcome: 'unknown' | 'budget-held'; code: string };

function exact(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** 规范化前先拒绝未知字段；同业务编号异文必须到 handler 并明确冲突。 */
export function pushHandbackPayload(value: PushHandbackRequest): string {
  if (
    !value ||
    typeof value !== 'object' ||
    !exact(value, ['version', 'requestId', 'token', 'by', 'feedback']) ||
    value.version !== 1 ||
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
    version: 1,
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
