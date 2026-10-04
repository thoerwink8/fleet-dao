// 驾驶舱接口约定（web-api）：任务详情，和发给工作流的信号。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import type { SegmentRunView } from '../segment-runs.ts';
import type { TaskUsage } from '../usage.ts';
import { BoardSubtaskSchema, RepoSchema } from './board.ts';
import {
  BillingKindSchema,
  HostIdSchema,
  RunOutcomeSchema,
  SegmentKindSchema,
  SegmentOutcomeSchema,
  SegmentTierSchema,
  StageKindSchema,
  TaskStateSchema,
} from './enums.ts';
import { Id, type Same, Time } from './internal.ts';

// —— 任务详情 ——

export const TaskSchema = z.object({
  id: Id,
  repoId: Id,
  issueNumber: z.number().int().positive(),
  title: z.string(),
  rawRequest: z.string(),
  requestedBy: z.string(),
  state: TaskStateSchema,
  priority: z.number(),
  specDir: z.string().optional(),
  createdAt: Time,
});

export const RunSchema = z.object({
  id: Id,
  subtaskId: Id.optional(),
  stage: StageKindSchema,
  routeId: Id,
  modelName: z.string(),
  hostId: HostIdSchema.optional(),
  /** 一句话「为什么派给它」。 */
  whyRoute: z.string(),
  queuedAt: Time,
  startedAt: Time.optional(),
  endedAt: Time.optional(),
  outcome: RunOutcomeSchema.optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  cacheReadTokens: z.number().int().min(0).optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  /** 路由所在渠道的计费方式：按量的花费是真花的钱，套餐内的只是按 API 价折合。渠道查不到就没有（不猜成套餐内）。 */
  billing: BillingKindSchema.optional(),
});

// 用量汇总：算法和各栏的意思在 usage.ts。每一样只加读到的，没读到的次数在 missing* 里，不当成 0。
const Count = z.number().int().min(0);
const CostShareSchema = z.object({ runs: Count, usd: z.number().min(0), missing: Count });
export const UsageTotalsSchema = z.object({
  runs: Count,
  running: Count,
  notStarted: Count,
  inputTokens: Count,
  outputTokens: Count,
  missingTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  missingCache: Count,
  inputEquivalent: Count,
  missingEquivalent: Count,
  costUsd: z.number().min(0),
  missingCost: Count,
  /** 花费按计费方式分开：按量（真花的钱）、套餐内（按 API 价折合，不另花钱）、渠道查不到分不清的。 */
  cost: z.object({ metered: CostShareSchema, subscription: CostShareSchema, unknown: CostShareSchema }),
  queueMs: Count,
  runMs: Count,
  missingTime: Count,
  /** 结束了的里没有排队记录的笔数（三段的 runs 不记排队）：排队合计要把它算作没读到。 */
  noQueue: Count,
});
const ModelUsageTotalsSchema = UsageTotalsSchema.extend({ model: z.string(), modelName: z.string() });
export const TaskUsageSchema = z.object({
  total: UsageTotalsSchema,
  byModel: z.array(ModelUsageTotalsSchema),
  byStage: z.array(UsageTotalsSchema.extend({ stage: StageKindSchema })),
  /** 三段按段（对题、动手、验收；段名认不出的 segment 为 null，排最后），每段再按模型分。 */
  bySegment: z.array(
    UsageTotalsSchema.extend({
      segment: SegmentKindSchema.nullable(),
      tiers: z.array(SegmentTierSchema),
      missingTier: Count,
      byModel: z.array(ModelUsageTotalsSchema),
    }),
  ),
});
/** 编译期闸：和 usage.ts 算出来的形状一字不差，改了一边没改另一边 `tsc` 当场报错。 */
export const USAGE_MATCHES_SUMMARY: Same<z.infer<typeof TaskUsageSchema>, TaskUsage> = true;

/** 一笔三段哪一样没读到、为什么（segment-runs.ts 的 readSegmentRun 判）。 */
export const UnreadNoteSchema = z.object({
  item: z.enum(['segment', 'time', 'outcome', 'tokens', 'cost', 'tier']),
  reason: z.string().min(1),
});

/**
 * 三段（库里的 runs 表）的一笔，读好给页面的样子：只给认得出的值，认不出、没记的写在 unread 里带原因，不拿 0 顶。
 * 怎么读见 segment-runs.ts。
 */
export const SegmentRunSchema = z.object({
  id: Id,
  /** 认不出的段是 null（原样在 unread 的原因里）。 */
  segment: SegmentKindSchema.nullable(),
  /** 路由挑的模型（模型目录的 id）和给人看的名字。 */
  model: z.string(),
  modelName: z.string(),
  channel: z.string().optional(),
  /** 渠道的计费方式：按量的花费是真花的钱，套餐内的只是按 API 价折合。渠道查不到就没有（不猜成套餐内）。 */
  billing: BillingKindSchema.optional(),
  /** 派工档；只有动手段分档。 */
  tier: SegmentTierSchema.optional(),
  startedAt: Time.optional(),
  endedAt: Time.optional(),
  /** 还在跑：没结束、单子也没结束。用量等它结束才有。 */
  running: z.boolean(),
  outcome: SegmentOutcomeSchema.optional(),
  /** 结束 − 开始（毫秒）；起止读不到的没有。 */
  durationMs: Count.optional(),
  inputTokens: Count.optional(),
  outputTokens: Count.optional(),
  cacheReadTokens: Count.optional(),
  cacheWriteTokens: Count.optional(),
  costUsd: z.number().min(0).optional(),
  memoryPeakMb: Count.optional(),
  failureReason: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  branch: z.string().optional(),
  /** task = 按 task_id 对上；issueNumber = 这笔没记 task_id、按单号兜底对上的（单号几个仓可能重）。 */
  matchedBy: z.enum(['task', 'issueNumber']),
  unread: z.array(UnreadNoteSchema),
});
/** 编译期闸：和 segment-runs.ts 读出来的形状一字不差。 */
export const SEGMENT_RUN_MATCHES_READING: Same<z.infer<typeof SegmentRunSchema>, SegmentRunView> = true;

export const AskSchema = z.object({
  id: Id,
  runId: Id.optional(),
  question: z.string(),
  options: z.array(z.string()),
  askedAt: Time,
  status: z.enum(['pending', 'answered']),
  answer: z.string().optional(),
  answeredBy: z.string().optional(),
  answeredAt: Time.optional(),
  /**
   * 问他不挡路（#259）：task = 这张单范围内的岔路，已按推荐先做；outside = 超出范围，另开单等他拍；
   * hold = 碰了人闸，先按推荐做、合并前等批。没有 = 老式的（会话停着等回答）。
   */
  scope: z.enum(['task', 'outside', 'hold']).optional(),
  /** 推荐的那个（选项里排第一个）。 */
  recommended: z.string().optional(),
  /** scope = hold 时碰的是哪类：release 对外发布、spend 花钱、delete 删数据、standard 改标准。 */
  hold: z.enum(['release', 'spend', 'delete', 'standard']).optional(),
  /**
   * 按推荐先做了的、回答了之后会怎样（core 的 lateAnswer）：confirmed 选的就是推荐的；applied 已照改；
   * change 下个存档点改；follow-up 这张单已合，开后续单；recorded 这张单没做成就停了，只记下。
   */
  effect: z.enum(['confirmed', 'applied', 'change', 'follow-up', 'recorded']).optional(),
  /** 为这条提问另开的单（超出范围的，或合并后才改的后续单）。 */
  followUpIssue: z.number().int().positive().optional(),
});

export const TaskDetailResponse = z.object({
  task: TaskSchema,
  repo: RepoSchema,
  subtasks: z.array(BoardSubtaskSchema),
  /** 老流程的会话（session_runs）。 */
  runs: z.array(RunSchema),
  /** 三段（runs 表）的流水，按起跑先后：task_id 对上的，加上 task_id 没记、按单号兜底的（matchedBy 标明）。 */
  segmentRuns: z.array(SegmentRunSchema),
  asks: z.array(AskSchema),
  /** 用量：老流程的会话加三段的流水整张合计、按模型；会话按阶段、三段按段（每段再按模型）。 */
  usage: TaskUsageSchema,
});

// —— 发给工作流的信号 ——

export const TaskActionRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause'), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('stop'), reason: z.string().max(500).optional() }),
  z.object({
    action: z.literal('reroute'),
    routeId: Id,
    /** 只换某个子任务的；不填 = 换这个需求当前在跑的那一个会话。 */
    subtaskId: Id.optional(),
    reason: z.string().max(500).optional(),
  }),
]);
export const TaskActionResponse = z.object({ ok: z.literal(true) });

// —— 旧会话留下的追问 ——
// v3 三段流程里没有「AI 追问」这一环（动手会话没有 fleet 令牌、发不出 fleet ask；引擎没有收回答的地方，#928、#939）。
// 库里还有的追问只来自还没删的旧会话：驾驶舱只读展示、能关闭；回答一律 409（asks_not_received）。

/** 回答追问的请求体。接口只剩飞书网关还在调、一律回 409（没有收信处），形状留着让它们照旧能解析、读到明确的 409。 */
export const AnswerAskRequest = z.object({ answer: z.string().min(1).max(4000) });

export const AnswerAskResponse = z.object({ ok: z.literal(true) });

/**
 * 「关闭」一条旧追问时写进 answer 的标记：库表没有「已关闭」这一列（加列要迁移，这件事不值得），关闭就是用这句话把它标成已处理，
 * 同一事务进操作记录（ask.close）。它不是任何人的回答，读 answer 的地方要认这句。
 */
export const LEGACY_ASK_CLOSED_ANSWER = '（旧会话留下的提问，已关闭，没有回答）';

/** 这条追问的 answer 是不是「关闭」写进去的那句标记（不是人的回答，别拿它去算「按推荐先做」的后果）。 */
export function isLegacyAskClosed(answer: string | undefined): boolean {
  return answer === LEGACY_ASK_CLOSED_ANSWER;
}

/** 通知中心里的一条旧追问：只读展示 + 「关闭」。 */
export const LegacyAskSchema = z.object({
  id: Id,
  taskId: Id,
  question: z.string(),
  askedAt: Time,
  /** 来源需求的一句话背景（#12 标题）；单子读不到就没有这个键。 */
  context: z.string().optional(),
  /** 站内路径：任务详情。 */
  link: z.string(),
});

export const LegacyAsksResponse = z.object({ items: z.array(LegacyAskSchema) });

export const CloseAskResponse = z.object({ ok: z.literal(true) });
