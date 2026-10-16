// 库里的行 → @fleet-dao/shared 的领域对象。
// 每个函数必须列出领域对象的每一个字段：domain.ts 加了字段而表没跟上，这里编译不过（这就是「表以 domain.ts 为准」的检查）。
// 时间转成 ISO 字符串；库里的空值变成「不填」。
import type {
  Ban,
  Channel,
  ChannelStateRecord,
  Family,
  Model,
  Pool,
  QuotaWindow,
  Repo,
  Route,
  SegmentRun,
  Subtask,
  Task,
} from '@fleet-dao/shared';
import { ciPolicyOf, probePaceWritten, redCheckNames } from '@fleet-dao/shared';
import type {
  bans,
  channelStates,
  channels,
  families,
  githubTokens,
  models,
  pools,
  quotaWindows,
  repos,
  routes,
  runs,
  subtasks,
  tasks,
} from './schema/index.ts';

type IsOptional<T, K extends keyof T> = Pick<T, K> extends Required<Pick<T, K>> ? false : true;
/** T 的每个键都得写；可选键允许写 undefined（输出时去掉）。 */
type EveryKey<T> = { [K in keyof T]-?: IsOptional<T, K> extends true ? T[K] | undefined : T[K] };

function build<T>(fields: EveryKey<T>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out as T;
}

const opt = <V>(v: V | null): V | undefined => v ?? undefined;
const isoOpt = (d: Date | null): string | undefined => d?.toISOString();

export const toRepo = (r: typeof repos.$inferSelect): Repo =>
  build<Repo>({
    id: r.id,
    owner: r.owner,
    name: r.name,
    defaultBranch: r.defaultBranch,
    testCommand: r.testCommand,
  });

/** 受管的仓，带「让 AI 接活」开关和 CI 模式（store 的 IntakeRepo 形状；#1989 加仓要回这个）。 */
export const toIntakeRepo = (r: typeof repos.$inferSelect) => ({
  ...toRepo(r),
  autoDispatchSince: isoOpt(r.autoDispatchSince) ?? null,
  ciPolicy: ciPolicyOf(r.ciPolicy),
});

/** 各人自己的 GitHub 授权那一行（#1989）；密文原样带出，解密在 api 层。 */
export const toGitHubToken = (r: typeof githubTokens.$inferSelect) => ({
  userId: r.userId,
  githubId: r.githubId,
  login: r.login,
  role: r.role === 'engine' ? ('engine' as const) : ('agent' as const),
  accessTokenCipher: r.accessTokenCipher,
  scopes: r.scopes,
  expiresAt: isoOpt(r.expiresAt) ?? null,
  updatedAt: r.updatedAt.toISOString(),
});

export const toTask = (r: typeof tasks.$inferSelect): Task =>
  build<Task>({
    id: r.id,
    repoId: r.repoId,
    issueNumber: r.issueNumber,
    title: r.title,
    rawRequest: r.rawRequest,
    requestedBy: r.requestedBy,
    state: r.state,
    priority: r.priority,
    specDir: opt(r.specDir),
    acceptance: r.acceptance,
    // 引擎暂停这张单（#820 片 3）时写 phase='paused'、doing='已暂停：…'；doing 是空的也不能当没暂停
    paused: r.phase === 'paused' ? (r.doing ?? '已暂停') : undefined,
    // 停下等人（#1967、#1971）：原因引擎写在 last_problem；没写照实说没写，不留空
    stalled:
      r.state === 'stalled'
        ? {
            why: r.lastProblem ?? r.doing ?? '引擎没写停下的原因',
            since: (r.updatedAt ?? r.createdAt).toISOString(),
          }
        : undefined,
    // 等合并时必过检查红了：doing 以「检查红了：」开头，后面是检查名（#1983）
    redChecks: redCheckNames(r.doing),
    // 只有本机领的单才带 executor、领取人和租约；没有这个键就是引擎（默认），和内存版一致
    executor: r.executor === 'local' ? 'local' : undefined,
    claimedBy: r.executor === 'local' ? opt(r.claimedBy) : undefined,
    leaseUntil: r.executor === 'local' ? isoOpt(r.leaseUntil) : undefined,
    createdAt: r.createdAt.toISOString(),
  });

export const toSubtask = (r: typeof subtasks.$inferSelect, dependsOn: string[]): Subtask =>
  build<Subtask>({
    id: r.id,
    taskId: r.taskId,
    index: r.index,
    title: r.title,
    touches: r.touches,
    dependsOn,
    state: r.state,
    prNumber: opt(r.prNumber),
    waitingOn: opt(r.waitingOn),
  });

export const toFamily = (r: typeof families.$inferSelect): Family =>
  build<Family>({ id: r.id, displayName: r.displayName, vendor: r.vendor });

export const toChannel = (r: typeof channels.$inferSelect): Channel =>
  build<Channel>({ id: r.id, name: r.name, billing: r.billing, enabled: r.enabled });

export const toChannelState = (r: typeof channelStates.$inferSelect): ChannelStateRecord =>
  build<ChannelStateRecord>({
    channelId: r.channelId,
    status: r.status,
    reason: opt(r.reason),
    failedRouteId: opt(r.failedRouteId),
    fallbackChannelId: opt(r.fallbackChannelId),
    fallbackModelId: opt(r.fallbackModelId),
    lastProbedAt: isoOpt(r.lastProbedAt),
    flaggedAt: isoOpt(r.flaggedAt),
    updatedAt: r.updatedAt.toISOString(),
  });

export const toPool = (r: typeof pools.$inferSelect): Pool =>
  build<Pool>({
    id: r.id,
    channelId: r.channelId,
    maxConcurrency: r.maxConcurrency,
    expiresAt: isoOpt(r.expiresAt),
    scopeModels: opt(r.scopeModels),
    lastReadOkAt: isoOpt(r.lastReadOkAt),
    runAsUser: opt(r.runAsUser),
    orgKind: opt(r.orgKind),
  });

export const toQuotaWindow = (r: typeof quotaWindows.$inferSelect): QuotaWindow =>
  build<QuotaWindow>({
    poolId: r.poolId,
    window: r.window,
    scope: r.scope === '' ? undefined : r.scope,
    utilization: opt(r.utilization),
    used: opt(r.used),
    limit: opt(r.limit),
    resetsAt: isoOpt(r.resetsAt),
    upstreamStatus: opt(r.upstreamStatus),
    reading: r.reading,
    readAt: r.readAt.toISOString(),
    label: r.label,
    unit: r.unit,
    source: r.source,
    statusRaw: opt(r.statusRaw),
    staleSince: isoOpt(r.staleSince),
  });

export const toModel = (r: typeof models.$inferSelect): Model =>
  build<Model>({
    id: r.id,
    family: r.family,
    displayName: r.displayName,
    retiredAt: isoOpt(r.retiredAt),
  });

export const toRoute = (r: typeof routes.$inferSelect): Route =>
  build<Route>({
    id: r.id,
    channelId: r.channelId,
    poolId: r.poolId,
    modelId: r.modelId,
    hostId: r.hostId,
    alive: r.alive,
    probe:
      r.probeState === null || r.probedAt === null
        ? undefined
        : {
            state: r.probeState,
            at: r.probedAt.toISOString(),
            ...(r.probeDetail ? { detail: r.probeDetail } : {}),
          },
    upstreamModel: opt(r.upstreamModel),
    upstreamAliases: r.upstreamAliases,
    variantEffort: opt(r.variantEffort),
    variantFast: opt(r.variantFast),
    variantThinking: opt(r.variantThinking),
    variantContext: opt(r.variantContext),
    goneAt: isoOpt(r.goneAt),
    // 节奏列（#1798 片 6）：写过的一起给；老行（四列都没写过）一个都不给，fail_streak 不拿默认 0 顶。
    // 「写过没有」只有 shared 的 probePaceWritten 一处判法（probe_fail_streak 有默认 0，单看它分不出没写过和清零写成 0）。
    ...(probePaceWritten(r)
      ? {
          probeTier: opt(r.probeTier),
          probeNextAt: isoOpt(r.probeNextAt),
          probeFailStreak: r.probeFailStreak,
          probeKind: opt(r.probeKind),
        }
      : {
          probeTier: undefined,
          probeNextAt: undefined,
          probeFailStreak: undefined,
          probeKind: undefined,
        }),
    // 疑似换模型和上次触发者（#1846）：空 = 没判过 / 老行，不给。
    suspectedSwap: opt(r.suspectedSwap),
    probeTrigger: opt(r.probeTrigger),
  });

/** routeIds 按调度台的先后；disabledRouteIds 是其中关着的（必须传：漏传就把关着的全当开着）。 */
export const toBan = (r: typeof bans.$inferSelect): Ban =>
  build<Ban>({
    family: opt(r.family),
    modelId: opt(r.modelId),
    stage: opt(r.stage),
    reason: r.reason,
  });

export const toSegmentRun = (r: typeof runs.$inferSelect): SegmentRun =>
  build<SegmentRun>({
    id: r.id,
    segment: r.segment,
    taskId: opt(r.taskId),
    issueNumber: opt(r.issueNumber),
    model: r.model,
    channel: opt(r.channel),
    tier: opt(r.tier),
    routeWhy: opt(r.routeWhy),
    startedAt: r.startedAt.toISOString(),
    endedAt: isoOpt(r.endedAt),
    outcome: opt(r.outcome),
    inputTokens: opt(r.inputTokens),
    outputTokens: opt(r.outputTokens),
    cacheReadTokens: opt(r.cacheReadTokens),
    cacheWriteTokens: opt(r.cacheWriteTokens),
    costUsd: opt(r.costUsd),
    usageNote: opt(r.usageNote),
    memoryPeakMb: opt(r.memoryPeakMb),
    cpuSeconds: opt(r.cpuSeconds),
    failureReason: opt(r.failureReason),
    prNumber: opt(r.prNumber),
    branch: opt(r.branch),
    workflowId: opt(r.workflowId),
    sessionId: opt(r.sessionId),
  });
