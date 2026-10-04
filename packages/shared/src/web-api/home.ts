// 驾驶舱接口约定（web-api）：新主页（/）：一屏三块 + 持续状态条。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { Id, Time } from './internal.ts';

// —— 新主页（/）：一屏三块 + 持续状态条（#589）——

/**
 * 「要你拍的」一条：decision 级通知（approvals 未决开的时候就经 openApproval 同步写了这么一条，
 * 不另查 approvals 表，免得一条事显示两回）+ 还没答的追问。
 */
export const HomeDecisionSchema = z.object({
  kind: z.enum(['notification', 'approval', 'ask']),
  id: Id,
  title: z.string(),
  /** 来源需求 / PR / 会话的一句话背景；没有就没有这个键。 */
  context: z.string().optional(),
  since: Time,
  /** 站内路径：通知详情 / 任务详情。 */
  link: z.string(),
});

/** 「在跑的」一张单。segment 由三段流水（runs 表）推出，一笔都没记的老单是 null，不许按字段猜成失败。 */
export const HomeRunningSchema = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string(),
  /** owner/name。 */
  repo: z.string(),
  /** 现在在哪一段；runs 里没有流水可推的是 null。verify_pending = 动手收了、验收还没起，是等，不是失败。 */
  segment: z.enum(['scoping', 'doing', 'verifying', 'verify_pending', 'merge']).nullable(),
  /** 为什么这一刻没进展。nothing = 正常在跑。 */
  waitingReason: z.enum([
    'queue',
    'memory',
    'quota_reset',
    'ci',
    'verify_round',
    'founder_decision',
    'merge_queue',
    'nothing',
  ]),
  /** 从什么时候起在等；waitingReason === 'nothing' 时没有。 */
  waitingSince: Time.optional(),
  /** 单子进库的时刻（「已经多久」的起点）。 */
  taskSince: Time.optional(),
  /** 在当前这一段待了多久的起点：这一段正在跑的那笔的开始，或上一笔收场的时刻；runs 里一笔都没有就没有这个键。 */
  stageSince: Time.optional(),
  /** 现在谁在做：正在跑的那一笔的模型名；这一刻没有进程在跑（排队、等人、等验）就没有这个键。 */
  worker: z.string().optional(),
  /** 在等创始人拍的那件事（要你拍的那块里挂在这张单上的第一条的标题）；没有就没有这个键。 */
  pendingDecision: z.string().optional(),
  /** 这张单最近一次事件（最近一笔三段流水的开始或收场）。trouble = 超时 / 失败 / 没起来；wait = 切号、内存满这类停下重跑，不是失败。 */
  lastEvent: z
    .object({
      text: z.string(),
      at: Time,
      tone: z.enum(['ok', 'wait', 'trouble']),
    })
    .optional(),
  /** 站内路径：任务详情。 */
  link: z.string(),
});

/**
 * 三段流水线的一段：在途几张、近期跑完的平均耗时。样本一笔都没有，avgMs 不给（不拿 0 冒充「瞬间完成」）。
 * 样本 = 看板窗口里的单的、结局是 done 且起止读得出来的三段流水。
 */
export const HomeFlowStageSchema = z.object({
  segment: z.enum(['scope', 'manual', 'verify']),
  inFlight: z.number().int().nonnegative(),
  avgMs: z.number().int().nonnegative().optional(),
  samples: z.number().int().nonnegative(),
});

/**
 * 「做完的」一篇 PR。链接前端按品牌拼（brand.repoLink，和 alert-work 一个规矩：后端不发网址）；
 * 这里给拼链接要的两段（repo 拆 owner/name 由前端按字符串切，和 alert-work 的 repoRef 一个切法）。
 */
export const HomeDoneSchema = z.object({
  prNumber: z.number().int().positive(),
  title: z.string(),
  /** owner/name。 */
  repo: z.string(),
  mergedAt: Time,
  /** 这篇 PR 挂的单（issueRefs 反查到的）；一个都没挂上没有这个键。 */
  issueNumber: z.number().int().positive().optional(),
});

/**
 * 持续状态条：额度、中转、引擎开关。有问题一直显示、不伪装成失败（tight/degraded/off 都不是「坏了」）。
 * engine 一项：后端读的是这台机器 release.env 的 FLEET_SERVICES（库自主管理才写的期望；运行时状态由 Temporal 拉，
 * 本切片只展示这个开关）。读不到（开发环境、机器上没有 release.env）按开着算，和 config.ts 的 engineEnabled 一个判法。
 */
export const HomeHealthSchema = z.object({
  quota: z.object({
    state: z.enum(['ok', 'tight', 'empty', 'unknown']),
    detail: z.string(),
  }),
  routes: z.object({
    state: z.enum(['ok', 'degraded', 'unknown']),
    detail: z.string(),
  }),
  engine: z.object({
    state: z.enum(['on', 'off']),
    detail: z.string().optional(),
  }),
});

export const HomeResponseSchema = z.object({
  decisions: z.array(HomeDecisionSchema),
  running: z.array(HomeRunningSchema),
  done: z.array(HomeDoneSchema),
  health: HomeHealthSchema,
  /** 三段流水线图头上的数：固定对题 → 动手 → 验收三项，按这个先后。 */
  flow: z.array(HomeFlowStageSchema).length(3),
  asOf: Time,
});
