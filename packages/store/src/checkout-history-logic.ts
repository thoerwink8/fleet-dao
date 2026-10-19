import type { HistoricalCheckoutArchiveInput, HistoricalCheckoutFacts, NewAuditEntry } from './ports.ts';

// 历史 checkout 卡处置的共用判断：内存版和 Postgres 版都调，两边口径一致。
// 引擎写这类通知的格式见 packages/engine/src/cold-verify-run.ts 的 checkoutBlockedAlert。

/** 检出报警的标题前缀（后面跟失败那一步）。 */
export const CHECKOUT_ALERT_TITLE_PREFIX = '冷验收放不进 PR 头的完整检出';

export const checkoutAlertKeyOf = (workflowId: string): string => `cold-verify:checkout:${workflowId}`;

/** 去掉重做代次后缀 `:rN`（N>=2），得到任务的基础工作流编号。 */
export const baseWorkflowIdOf = (workflowId: string): string => workflowId.replace(/:r[2-9][0-9]*$/, '');

// 以下照抄引擎 cold-verify-run.ts 的 STAGE_LABEL / adviceFor / checkoutBlockedAlert（store 不能依赖 engine）；
// 引擎测试 packages/engine/test/verify-checkout.test.ts 用真 checkoutBlockedAlert 逐种生成后过这里，两边漂移会红。
type CheckoutStage = 'fetch' | 'head' | 'mirror' | 'mkdir' | 'archive' | 'extract' | 'unknown';
const CHECKOUT_STAGE_LABEL: Record<CheckoutStage, string> = {
  fetch: '获取待验精确头',
  head: '核对 PR 头',
  mirror: '找引擎镜像',
  mkdir: '建检出目录',
  archive: '从镜像 git archive',
  extract: '解包到检出目录',
  unknown: '没认出是哪一步',
};

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 引擎冷验收检出目录：trees.tmpFor(`verify-<uuid>`) = `<root>/_tmp/verify-<uuid>`。 */
const DIR = '/[^\\s，。（）「」]*/_tmp/verify-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MIRROR = '/[^\\s，。（）「」]+';
const MIRROR_OR_NONE = `(?:${MIRROR}|（没有镜像路径）)`;

function stageAdvice(stage: CheckoutStage, head: string): string {
  switch (stage) {
    case 'head':
      return `PR 头 ${head} 不是完整提交号，查读 PR 的那一步。`;
    case 'mirror':
      return `对不上或没有引擎镜像(?:（${MIRROR}）)?，查工作流编号和镜像目录。`;
    case 'mkdir':
      return '建 \\k<dir> 没成（不是权限问题），查磁盘和路径。';
    case 'archive':
      return `镜像 ${MIRROR_OR_NONE} 上 git archive 没成，查镜像本身是否完好。`;
    case 'extract':
      return '解包到 \\k<dir> 没成，查磁盘空间和目录。';
    default:
      return '原始错误原样附上，按它查。';
  }
}

/** 这一步失败时引擎可能写出的整段正文（锚定首尾）：EACCES、缺对象、按步骤三类建议，各配对应的错误码写法。 */
function checkoutBodyPatterns(stage: CheckoutStage, workflowId: string, head: string): RegExp[] {
  const h = esc(head);
  const prefix = `^目标 ${esc(workflowId)} 的 head ${h}，目录 (?<dir>${DIR})。失败在「${esc(CHECKOUT_STAGE_LABEL[stage])}」这一步`;
  const body = (code: string, advice: string) =>
    new RegExp(`${prefix}${code}，原始错误：[\\s\\S]*?。${advice}$`, 'u');
  const notEacces = '(?:（(?!EACCES）)[A-Z][A-Z0-9_]*）)?';
  const patterns = [
    body(
      '（EACCES）',
      '(?:既有修复（ensure-tmp）没成：[\\s\\S]*?。)?引擎用户要能在这一层下面 mkdir（\\k<dir> 的上一层）。',
    ),
    body(notEacces, stageAdvice(stage, h)),
  ];
  // 缺对象只出在带步骤的 CheckoutStageError 上；认不出步骤的原错不会走这条建议。
  if (stage !== 'unknown')
    patterns.push(
      body(
        notEacces,
        `引擎镜像 ${MIRROR_OR_NONE} 里取不出目标 head ${h}（git archive 认不出这个对象）。` +
          '请检查镜像里有没有这个提交，按既定 head 把它 fetch 进镜像后再验。这不是目录权限问题，别改属主或权限；引擎不自动重试。',
      ),
    );
  return patterns;
}

/**
 * 通知本身得是引擎为这个目标、这个 head 写的检出失败报警：标题和正文整段符合受管格式（失败步骤、错误码、原始错误、
 * 对应建议都在且彼此一致），不是只有前缀或片段相似。
 */
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
  const stage = (Object.keys(CHECKOUT_STAGE_LABEL) as CheckoutStage[]).find(
    (s) => notification.title === `${CHECKOUT_ALERT_TITLE_PREFIX}（${CHECKOUT_STAGE_LABEL[s]}）`,
  );
  if (stage === undefined) return '通知标题不是受管的检出失败报警';
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
  if (!notification.body.startsWith(`目标 ${target.workflowId} 的 head ${target.head}，`))
    return '通知正文的目标或 head 与处置目标不一致';
  if (!checkoutBodyPatterns(stage, target.workflowId, target.head).some((p) => p.test(notification.body)))
    return '通知正文不是受管检出失败报警的完整格式（步骤、错误码、原始错误或建议对不上）';
  return undefined;
}

/**
 * 原 checkout 失败那一段能有的结局：真失败收场的。done（会话照常跑完）不算失败执行；admission_blocked 没进到放检出那一步；
 * org_switch 是切号后在原分支重跑，原执行没有收场。
 */
export const CHECKOUT_FAILED_RUN_OUTCOMES: readonly string[] = [
  'failed',
  'timeout',
  'killed',
  'spawn_failed',
];

/**
 * 原执行必须是这个任务这个 PR 的、已真实失败终态的 verify 段（冷验收放检出的那一段），
 * 且这条报警的事故时刻（raisedAt）落在这一段起止之内：别的段、成功收场的段都不是这张卡的原执行。
 */
export function checkoutRunProblem(
  run: {
    segment?: string | undefined;
    workflowId?: string | undefined;
    temporalRunId?: string | undefined;
    issueNumber?: number | undefined;
    endedAt?: string | undefined;
    outcome?: string | undefined;
    prNumber?: number | undefined;
    startedAt?: string | undefined;
  },
  target: { workflowId: string; temporalRunId: string; issueNumber: number; pr: number },
  raisedAt: string | undefined,
): string | undefined {
  if (run.segment !== 'verify') return '原执行不是 verify 段';
  if (run.workflowId !== target.workflowId || run.temporalRunId !== target.temporalRunId)
    return '原执行工作流或 Temporal run 不匹配';
  if (run.issueNumber !== target.issueNumber) return '原执行任务单号不匹配';
  if (run.endedAt === undefined || run.outcome === undefined) return '原执行未终态或结局缺失';
  if (!CHECKOUT_FAILED_RUN_OUTCOMES.includes(run.outcome))
    return `原执行结局是 ${run.outcome}，不是失败收场的执行`;
  if (run.prNumber !== target.pr) return '原执行的 PR 关联不匹配';
  const raised = raisedAt === undefined ? Number.NaN : Date.parse(raisedAt);
  const started = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  if (!(started <= raised && raised <= Date.parse(run.endedAt)))
    return '报警时刻不在原执行起止之内，不是这一段报的';
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
