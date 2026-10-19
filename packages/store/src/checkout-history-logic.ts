import type { HistoricalCheckoutArchiveInput, HistoricalCheckoutFacts, NewAuditEntry } from './ports.ts';

// 历史 checkout 卡处置的共用判断：内存版和 Postgres 版都调，两边口径一致。
// 引擎写这类通知的格式见 packages/engine/src/cold-verify-run.ts 的 checkoutBlockedAlert。

/** 检出报警的标题前缀（后面跟失败那一步）。 */
export const CHECKOUT_ALERT_TITLE_PREFIX = '冷验收放不进 PR 头的完整检出';

export const checkoutAlertKeyOf = (workflowId: string): string => `cold-verify:checkout:${workflowId}`;

/** 去掉重做代次后缀 `:rN`（N>=2），得到任务的基础工作流编号。 */
export const baseWorkflowIdOf = (workflowId: string): string => workflowId.replace(/:r[2-9][0-9]*$/, '');

/** 通知本身得是这个目标、这个 head 的检出失败报警：标题、目标/head 句式、失败步骤和原始错误都在。 */
export function checkoutNotificationProblem(
  notification: {
    title: string;
    body: string;
    taskId?: string | undefined;
    link?: string | null | undefined;
  },
  target: {
    workflowId: string;
    head: string;
    taskId?: string | undefined;
    repo?: string | undefined;
    pr?: number | undefined;
  },
): string | undefined {
  if (!notification.title.startsWith(CHECKOUT_ALERT_TITLE_PREFIX)) return '通知标题不是检出失败报警';
  if (
    target.taskId !== undefined &&
    notification.taskId !== undefined &&
    notification.taskId !== target.taskId
  )
    return '通知没有绑定原任务';
  if (
    target.repo !== undefined &&
    target.pr !== undefined &&
    notification.link !== undefined &&
    notification.link !== null &&
    notification.link !== `https://github.com/${target.repo}/pull/${target.pr}`
  )
    return '通知没有绑定原 PR';
  if (!notification.body.includes(`目标 ${target.workflowId} 的 head ${target.head}，`))
    return '通知正文的目标或 head 与处置目标不一致';
  if (!notification.body.includes('失败在「') || !notification.body.includes('原始错误：'))
    return '通知正文缺失败步骤或原始错误';
  return undefined;
}

/** 原执行必须是这个任务这个 PR 的、已真实终态的 verify 段（冷验收放检出的那一段）。 */
export function checkoutRunProblem(
  run: {
    segment?: string | undefined;
    workflowId?: string | undefined;
    temporalRunId?: string | undefined;
    issueNumber?: number | undefined;
    endedAt?: string | undefined;
    outcome?: string | undefined;
    prNumber?: number | undefined;
  },
  target: { workflowId: string; temporalRunId: string; issueNumber: number; pr: number },
): string | undefined {
  if (run.segment !== 'verify') return '原执行不是 verify 段';
  if (run.workflowId !== target.workflowId || run.temporalRunId !== target.temporalRunId)
    return '原执行工作流或 Temporal run 不匹配';
  if (run.issueNumber !== target.issueNumber) return '原执行任务单号不匹配';
  if (run.endedAt === undefined || run.outcome === undefined) return '原执行未终态或结局缺失';
  if (run.prNumber !== target.pr) return '原执行的 PR 关联不匹配';
  return undefined;
}

/** Store 也必须核对完整处置凭据，不能只依赖 CLI 的 zod 校验。 */
export function checkoutAuditProblem(
  input: HistoricalCheckoutArchiveInput,
  facts: HistoricalCheckoutFacts,
  entry: NewAuditEntry,
): string | undefined {
  if (
    entry.actor.kind !== 'ops' ||
    entry.actor.id !== 'ops:checkout-history' ||
    entry.action !== 'notification.checkout_history_archive' ||
    entry.target !== `notification:${input.notificationId}` ||
    entry.via !== 'ops' ||
    !entry.ok ||
    entry.reason !== input.reason
  )
    return '历史 checkout 审计身份或原因不完整';
  if (
    !input.operator.trim() ||
    !input.reason.trim() ||
    !input.evidence.trim() ||
    !input.gaps.trim() ||
    !input.responsibility.trim() ||
    input.conclusion !== 'historical_unproven'
  )
    return '历史 checkout 处置凭据不完整';
  const before = entry.before;
  const after = entry.after;
  if (!before || typeof before !== 'object' || !after || typeof after !== 'object')
    return '历史 checkout 审计快照不完整';
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const beforeFields = {
    notificationId: input.notificationId,
    dedupeKey: input.dedupeKey,
    raisedAt: input.raisedAt,
    repo: input.repo,
    taskId: input.taskId,
    workflowId: input.workflowId,
    runId: input.runId,
    temporalRunId: input.temporalRunId,
    pr: input.pr,
    head: input.head,
  };
  if (Object.entries(beforeFields).some(([key, value]) => beforeRecord[key] !== value))
    return '历史 checkout 原始身份快照不完整';
  const afterFields = {
    ...input,
    originalTitle: facts.notification.title,
    runFailureReason: facts.run.failureReason ?? null,
    conclusion: 'historical_unproven',
  };
  if (Object.entries(afterFields).some(([key, value]) => afterRecord[key] !== value))
    return '历史 checkout 处置结论或证据不完整';
  return undefined;
}
