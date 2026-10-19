// 历史 checkout 卡处置的共用判断：内存版和 Postgres 版都调，两边口径一致。
// 引擎写这类通知的格式见 packages/engine/src/cold-verify-run.ts 的 checkoutBlockedAlert。

/** 检出报警的标题前缀（后面跟失败那一步）。 */
export const CHECKOUT_ALERT_TITLE_PREFIX = '冷验收放不进 PR 头的完整检出';

export const checkoutAlertKeyOf = (workflowId: string): string => `cold-verify:checkout:${workflowId}`;

/** 去掉重做代次后缀 `:rN`（N>=2），得到任务的基础工作流编号。 */
export const baseWorkflowIdOf = (workflowId: string): string => workflowId.replace(/:r[2-9][0-9]*$/, '');

/** 通知本身得是这个目标、这个 head 的检出失败报警：标题、目标/head 句式、失败步骤和原始错误都在。 */
export function checkoutNotificationProblem(
  notification: { title: string; body: string },
  target: { workflowId: string; head: string },
): string | undefined {
  if (!notification.title.startsWith(CHECKOUT_ALERT_TITLE_PREFIX)) return '通知标题不是检出失败报警';
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
    endedAt?: string | undefined;
    outcome?: string | undefined;
    prNumber?: number | undefined;
  },
  target: { workflowId: string; temporalRunId: string; pr: number },
): string | undefined {
  if (run.segment !== 'verify') return '原执行不是 verify 段';
  if (run.workflowId !== target.workflowId || run.temporalRunId !== target.temporalRunId)
    return '原执行工作流或 Temporal run 不匹配';
  if (run.endedAt === undefined || run.outcome === undefined) return '原执行未终态或结局缺失';
  if (run.prNumber !== target.pr) return '原执行的 PR 关联不匹配';
  return undefined;
}
