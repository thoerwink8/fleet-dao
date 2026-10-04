// 驾驶舱接口约定（web-api）：账号池与额度。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import {
  BillingKindSchema,
  QuotaStatusSchema,
  QuotaUnitSchema,
  QuotaWindowKindSchema,
  ReadingKindSchema,
} from './enums.ts';
import { Id, Time } from './internal.ts';

// —— 账号池与额度 ——

export const QuotaWindowViewSchema = z.object({
  /** 上游对这个窗口的原名（5h、7d_claude、auto_percent……），同一池里不重复。显示用它；window 只是归类。 */
  label: z.string().min(1),
  /** 归类；上游新出的、归不了类的是 other，看 label。 */
  window: QuotaWindowKindSchema,
  /** 只扣某一组模型的窗口的组名（中转的 fable、Cursor 的 auto / api 桶……）；账号级窗口没有。 */
  scope: z.string().optional(),
  /** 已用比例。超额是真实情况，可以大于 1——原样给出，显示进度条时再截到 100%。 */
  utilization: z.number().min(0).optional(),
  used: z.number().optional(),
  limit: z.number().optional(),
  /** used / limit 的单位。上游只给百分比时是 percent，limit 是 100。 */
  unit: QuotaUnitSchema,
  resetsAt: Time.optional(),
  /** 上游自己说的状态，以它为准（实测 99% 就可能已经 limit_reached）。 */
  upstreamStatus: QuotaStatusSchema.optional(),
  /** 上游的原状态字：归不进 upstreamStatus 的也原样给人看，不猜。 */
  statusRaw: z.string().optional(),
  /** measured = 实读；estimated = 按用量估算。 */
  reading: ReadingKindSchema,
  /** 读法：claude-usage、mirasim-relay、cursor-dashboard、grok-billing、estimate……（官方接口、网页接口还是估算）。 */
  source: z.string().min(1),
  readAt: Time,
  /**
   * 过期标记：读成了、但上游从这个时刻起没再报这个窗口。照样显示，注明「上游这次没报」；不挡路由、不参与排序。
   * 上游重新报了就清空，满 24 小时库里删掉（数据库包的 savePoolQuota 管）。
   */
  staleSince: Time.optional(),
  /** 这条读数本身太旧（读数时刻超过 staleAfterMinutes），不能当现值用。 */
  stale: z.boolean(),
});

export const PoolViewSchema = z.object({
  id: Id,
  channelId: Id,
  channelName: z.string(),
  /** null = 这个池挂的渠道在库里查不到（数据不一致），计费方式未知——不猜成「套餐内」。 */
  billing: BillingKindSchema.nullable(),
  channelEnabled: z.boolean(),
  /** Claude 订阅池对应的组织类型（独享 / 拼车）；不是 Claude 订阅池没有。额度页顶上的切号现状按它认出独享池。 */
  orgKind: z.enum(['solo', 'carpool']).optional(),
  maxConcurrency: z.number().int().min(0),
  /** 正在跑的会话数。 */
  running: z.number().int().min(0),
  expiresAt: Time.optional(),
  /**
   * 按池看，不逐窗口看（和每小时对账、选路由同一个判法，数据库包的 quotaReadOverdue）：
   * unread = 一次都没读成过（没查成，不是「没用量」）；stale = 最近一次读成、或上游数据本身超过 staleAfterMinutes；fresh = 其余。
   */
  quotaStatus: z.enum(['fresh', 'stale', 'unread']),
  /** 最近一次完整读成的时刻（我们读的时刻），读失败不动；一次都没读成过就没有。 */
  lastReadOkAt: Time.optional(),
  /** 上游数据本身的时刻：还在报的窗口里最新的读数时刻（中转给的是它自己的采集时刻）。读成了、上游的数却冻住时看它。 */
  dataAt: Time.optional(),
  /** 按清零时刻排，快清零的在前（不知道清零时刻的在后）；同时清零的按原名。 */
  windows: z.array(QuotaWindowViewSchema),
});

/**
 * 会话用户切号的现状（#194，方案 v2 4.4：驾驶舱额度表顶上一行「挂着独享；拼车预计 HH:MM 恢复」）。从引擎落库的切号账本读：
 * unavailable = 没接上（开发、内存版）或引擎还没记过；unreadable = 账本在库里却认不出（引擎也因此不切号，要人看）；
 * known = 读到了。soloPaused 是设置里的「引擎暂不用独享」（人叫停）。
 */
export const SoloReserveViewSchema = z.object({
  /** reached = 独享到了留量线；unreadable = 留量线的设置认不出（引擎也因此不派、不切独享）；unknown = 配了线、对应的读数读不到（按额度未知，照派）。 */
  state: z.enum(['reached', 'unreadable', 'unknown']),
  why: z.string(),
});

export const OrgSwitchViewSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('unavailable'),
    why: z.string(),
    soloPaused: z.boolean(),
    soloReserve: SoloReserveViewSchema.optional(),
  }),
  z.object({
    state: z.literal('unreadable'),
    why: z.string(),
    soloPaused: z.boolean(),
    soloReserve: SoloReserveViewSchema.optional(),
  }),
  z.object({
    state: z.literal('known'),
    /** 引擎最近一次读到会话用户挂的组织（拼车 / 独享）；还没读到过为 null。 */
    live: z.enum(['carpool', 'solo']).nullable(),
    liveAt: Time.optional(),
    /** 这一次挂到独享的时刻（挂着拼车没有）。 */
    onSoloSince: Time.optional(),
    /** 记着的拼车恢复条件：哪一种用不了（E1 本人额度、E2 整辆车、E3 组织本身）、凭什么、预计几点恢复、从哪读来。 */
    outage: z
      .object({
        kind: z.enum(['E1', 'E2', 'E3']),
        evidence: z.string(),
        since: Time,
        resetsAt: Time.optional(),
        resetsFrom: z.enum(['api', 'text']).optional(),
      })
      .optional(),
    /** 渠道（所有 Claude 账号合起来）：ok 可用 ≥ 2；single 只剩 1 个；unavailable 一个都没有；unknown 读不到账号状态。 */
    channel: z
      .object({
        state: z.enum(['ok', 'single', 'unavailable', 'unknown']),
        since: Time,
        why: z.string(),
      })
      .optional(),
    /** 切回宽限从这一刻起（新活不往独享派）；不在宽限中没有。 */
    backPendingSince: Time.optional(),
    /** 连着白切几次。 */
    whites: z.number().int().min(0),
    /** 最近一次读接口：几点、成没成（没成写原因）。 */
    lastRead: z.object({ at: Time, ok: z.boolean(), why: z.string().optional() }).optional(),
    /**
     * 拼车额度烧得多快（#194 方案 4.1，shared 的 estimateBurn 按最近 15 分钟的接口读数算）：
     * known 带每分钟花多少、还剩多少、还能撑几分钟（null = 最近没在花、用不满）；unknown = 还算不出（写原因，不显示 0 也不显示猜的数）。
     * 挂着独享时不算（那时本人拼车额度没在花）；后端没带这一项（老后端）没有。
     */
    burn: z
      .discriminatedUnion('state', [
        z.object({
          state: z.literal('known'),
          usdPerMinute: z.number().min(0),
          remainingUsd: z.number().min(0),
          minutesLeft: z.number().min(0).nullable(),
          spanMinutes: z.number().positive(),
        }),
        z.object({ state: z.literal('unknown'), why: z.string() }),
      ])
      .optional(),
    soloPaused: z.boolean(),
    /** 独享的额度留量线现状（#194 方案 4.8）：没到线、也没有要说的就没有这一项。 */
    soloReserve: SoloReserveViewSchema.optional(),
    updatedAt: Time,
  }),
]);

/**
 * 拼车额度对账（#194 方案 4.7）：这一窗本机记到在拼车上花了多少，接口说用了多少；差得多、扣掉没记到花费的会话以后还差得多，
 * 多半是别的设备在用。先只显示、不报警。unavailable = 没法对（没读到窗口、窗口已过、没接上），why 写明，不拿「对得上」冒充。
 * verdict：match 对得上 / others 差得多、多半是别的设备在用 / unrecorded 没记到花费的会话太多、说不准 / local_over 本机记的比接口说的还多。
 */
export const CarpoolReconcileViewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable'), why: z.string() }),
  z.object({
    state: z.literal('known'),
    windowStart: Time,
    windowEnd: Time,
    /** 接口这次读数的时刻；本机的花费也只算到这一刻开始的会话。 */
    apiReadAt: Time,
    localUsd: z.number().min(0),
    apiUsedUsd: z.number().min(0),
    apiLimitUsd: z.number().positive(),
    /** 窗口里开始了的拼车会话数、其中没记到花费的、其中被切号停下的。 */
    sessions: z.number().int().min(0),
    unrecorded: z.number().int().min(0),
    unrecordedSwitchStopped: z.number().int().min(0),
    /** 接口说的减本机记的（可为负）。 */
    gapUsd: z.number(),
    verdict: z.enum(['match', 'others', 'unrecorded', 'local_over']),
    /** 给人看的一句话（差多少、凭什么这么说）。 */
    note: z.string(),
  }),
]);

export const PoolsResponse = z.object({
  pools: z.array(PoolViewSchema),
  staleAfterMinutes: z.number().int().positive(),
  /** 切号现状。后端没接这一块（老后端）没有这一项。 */
  orgSwitch: OrgSwitchViewSchema.optional(),
  /** 拼车额度对账。后端没接这一块（老后端）没有这一项。 */
  carpoolReconcile: CarpoolReconcileViewSchema.optional(),
  asOf: Time,
});
