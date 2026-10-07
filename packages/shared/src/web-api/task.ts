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

export const TaskDetailResponse = z.object({
  task: TaskSchema,
  repo: RepoSchema,
  subtasks: z.array(BoardSubtaskSchema),
  /** 老流程的会话（session_runs）。 */
  runs: z.array(RunSchema),
  /** 三段（runs 表）的流水，按起跑先后：task_id 对上的，加上 task_id 没记、按单号兜底的（matchedBy 标明）。 */
  segmentRuns: z.array(SegmentRunSchema),
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
