// 驾驶舱接口约定（web-api）：任务详情，和发给工作流的信号。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { FLOW_MODES, type FlowMode } from '../flow-mode.ts';
import type { CostEstimate } from '../model-prices.ts';
import { RUN_CAUSES } from '../run-cause.ts';
import { RunVerdictSchema } from '../run-verdict.ts';
import type { SegmentRunView } from '../segment-runs.ts';
import type { RunProcess, RunTally } from '../task-process.ts';
import { TRANSCRIPT_KINDS, TRANSCRIPT_PAGE_DEFAULT, TRANSCRIPT_PAGE_MAX } from '../transcript.ts';
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
  TaskExecutorSchema,
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
  /** 被人暂停了（#820 片 3）：引擎写的「已暂停：被谁暂停、为什么」；没暂停没有这个键。暂停的单 state 仍是 running。 */
  paused: z.string().optional(),
  /**
   * 停下等人（state=stalled）：引擎写的为什么停。任务页用它认「继续次数已用满」，把「继续」改成提示用 redo。
   * 没停下没有这个键。老后端推来的详情没有，当普通停滞，继续仍可点。
   */
  stalled: z.object({ why: z.string(), since: Time }).optional(),
  /** 谁在做：engine = 法国引擎，local = 本机领的（决定 0096，tasks.executor）。老后端、老环境推来的快照没有这个键，当引擎。 */
  executor: TaskExecutorSchema.optional(),
  /** 本机领的单：领它的环境编号（通行证认出的，如 founder-pc；tasks.claimed_by）。引擎的单没有这个键。 */
  claimedBy: z.string().optional(),
  /** 本机领的单：租约到期的时刻（tasks.lease_until）；到点没续就退回法国队列。引擎的单没有这个键。 */
  leaseUntil: Time.optional(),
  /**
   * 这张单实际走的流程（tasks.flow_mode，#2828）：three 三段、full 全程。
   * 还没分组的老单没有这个键。页面不补、不猜。
   */
  flowMode: z.enum(FLOW_MODES).optional(),
  /**
   * 不合格、实际退回三段的原因（分组记录 source = ineligible，且不是「开关就是三步法」）。
   * 没有这个键就不是退回。老后端没有，页面不猜。
   */
  flowFallback: z.string().min(1).optional(),
  createdAt: Time,
});
/** 编译期闸：和 flow-mode.ts 的两种模式一字不差。 */
export const TASK_FLOW_MODE_MATCHES: Same<
  NonNullable<z.infer<typeof TaskSchema>['flowMode']>,
  FlowMode
> = true;

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
  /** 没报花费的那几笔按模型目录的单价估（model-prices.ts）：估成了几笔、合计；没有单价几笔；token 没读全几笔。 */
  estimate: z.object({ runs: Count, usd: z.number().min(0), noPrice: Count, noTokens: Count }),
  runMs: Count,
  missingTime: Count,
  /** 结束了的三段里四样 token 一个都没读到的段数。页面写「另有 N 段读不到用量」。 */
  unreadSegments: Count,
});
const ModelUsageTotalsSchema = UsageTotalsSchema.extend({ model: z.string(), modelName: z.string() });
export const TaskUsageSchema = z.object({
  total: UsageTotalsSchema,
  byModel: z.array(ModelUsageTotalsSchema),
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

/** 一笔没报花费时按目录单价的估算（model-prices.ts 的 CostEstimate）。 */
export const CostEstimateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('estimated'), usd: z.number().min(0) }),
  z.object({ kind: z.literal('noPrice'), why: z.string().min(1) }),
  z.object({ kind: z.literal('noTokens'), why: z.string().min(1) }),
]);
/** 编译期闸：和 model-prices.ts 的形状一字不差。 */
export const COST_ESTIMATE_MATCHES: Same<z.infer<typeof CostEstimateSchema>, CostEstimate> = true;

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
  /** 选路时那句「为什么派它」。没记的老行没有，页面写「没记」。 */
  routeWhy: z.string().min(1).optional(),
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
  /** 执行体没报花费（订阅制）时按目录单价估的；报了花费的、在跑的、没起来的没有。 */
  estimate: CostEstimateSchema.optional(),
  memoryPeakMb: Count.optional(),
  /** 这一次会话的 CPU 秒数（大于 0）。没记不给，不当 0（#1980）。 */
  cpuSeconds: z.number().int().positive().optional(),
  /** 判定不开上一段会话时的原因；页面原样显示。 */
  resumeReason: z.string().min(1).optional(),
  /** 是新会话还是接上一笔的会话（#3140）：true 接上一笔，false 新会话（原因在 resumeReason），都没记不给。 */
  resumed: z.boolean().optional(),
  /** 为什么起这一笔、摘要、所属回合（task_rounds.seq）、验收这一笔的结论（#3140）；老行没有，页面写「老记录没记」。 */
  cause: z.enum(RUN_CAUSES).optional(),
  causeSummary: z.string().min(1).optional(),
  roundSeq: z.number().int().positive().optional(),
  verdict: RunVerdictSchema.optional(),
  failureReason: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  branch: z.string().optional(),
  /** task = 按 task_id 对上；issueNumber = 这笔没记 task_id、按单号兜底对上的（单号几个仓可能重）。 */
  matchedBy: z.enum(['task', 'issueNumber']),
  unread: z.array(UnreadNoteSchema),
});
/** 编译期闸：和 segment-runs.ts 读出来的形状一字不差。 */
export const SEGMENT_RUN_MATCHES_READING: Same<z.infer<typeof SegmentRunSchema>, SegmentRunView> = true;

// —— 按单指定模型（「每个任务能点进去随意切换模型」）——
// 存在库里（task_route_pins），引擎每次给这张单的这一段选路时现读（engine 的 real/store-ports.ts）：在跑的这一轮不打断，
// 下一次选路（下一轮、重试、验收开始）就按它；指定的模型派不出时引擎停下等人、写明原因，不悄悄换别的。

/** 经选路的两段：动手、验收（对题在对话里做，不经引擎选路，指定不了）。 */
export const RoutedSegmentSchema = z.enum(['manual', 'verify']);

export const TaskRoutePinSchema = z.object({
  segment: RoutedSegmentSchema,
  /** 指定的模型（模型目录的 id）；没有 = 清掉了指定、回到自动。 */
  modelId: z.string().optional(),
  /** 还钉到了这个模型下的哪条路由；没有 = 这个模型下按路由顺序挑。 */
  routeId: z.string().optional(),
  /** 谁定的（用户编号）。 */
  setBy: z.string(),
  setAt: Time,
  reason: z.string().optional(),
});

export const TaskRoutePinsSchema = z.object({
  /** 每段最多一条；没有这一段的 = 从没指定过，自动。 */
  pins: z.array(TaskRoutePinSchema),
  /** 这里读不了（开发环境的内存版没有这张表）：写明为什么，不拿空列表冒充「没指定」。 */
  unavailable: z.string().optional(),
});

/** 指定或清掉一段的模型。modelId 为 null = 清掉、回到自动；routeId 只在给了 modelId 时能给，而且要是这个模型的路由。 */
export const UpdateTaskRoutePinRequest = z
  .object({
    segment: RoutedSegmentSchema,
    modelId: Id.nullable(),
    routeId: Id.nullable().optional(),
    reason: z.string().max(500).optional(),
    /**
     * 「现在就换」（#1216）：除了写下指定，还让正在跑的这一段当场停下、按新指定的模型原分支重跑（已做的从分支上接着做，已花的 token 不退）。
     * 只有动手段能换；单子不在跑、或在跑的不是这一段，回 409 写明原因、什么都不改。不给 = 老样子：下一次选路起生效，在跑的不打断。
     */
    now: z.boolean().optional(),
  })
  .refine((b) => !b.routeId || b.modelId, {
    message: '只给路由不给模型不行：清掉指定时 routeId 也要空',
    path: ['routeId'],
  });
export const UpdateTaskRoutePinResponse = TaskRoutePinSchema;

// —— 任务页的概览和过程（#3140）——
// 算法在 task-process.ts（切步、小计）。读不到的写原因，不拿 0 顶：每一块都是「读到了 / 没有 / 读不到带原因」三态，
// 页面照写「没读到」「老记录没记」，不画 0。

export const FileChangeSchema = z.object({
  path: z.string(),
  /** 这个文件成功改了几次。 */
  edits: Count,
  /** 已记下的增删行数合计；这个文件的编辑一次都没记行数就没有这两个键。 */
  added: Count.optional(),
  removed: Count.optional(),
});

export const ProcessStepSchema = z.object({
  index: Count,
  /** 这一步的标题：Agent 开头那句话；先调工具的是「动词 对象」；什么都没有是 null。 */
  title: z.string().nullable(),
  titleFromCall: z.boolean(),
  firstSeq: Count,
  lastSeq: Count,
  startedAt: Time,
  /** 下一步开始的时刻 / 这一笔收场的时刻；这一步还在跑没有。 */
  endedAt: Time.optional(),
  durationMs: Count.optional(),
  running: z.boolean(),
  /** 这一步有调用没成、报错、或结论没成：页面自动展开。 */
  failed: z.boolean(),
  calls: Count,
  subCalls: Count,
  commands: Count,
  commandsFailed: Count,
  /** 结果读不到的命令：老记录没调用号、收场了没记下结果、流里没有退出码（Mirasim）。 */
  commandsUnknown: Count,
  commandsRunning: Count,
  reads: Count,
  callsFailed: Count,
  files: z.array(FileChangeSchema),
  added: Count,
  removed: Count,
  /** 编辑成功了但没记行数的次数：增删合计少了这几次。 */
  uncounted: Count,
});

export const ProcessCountsSchema = z.object({
  commands: Count,
  commandsDone: Count,
  commandsFailed: Count,
  commandsUnknown: Count,
  commandsRunning: Count,
  reads: Count,
  callsFailed: Count,
  files: z.array(FileChangeSchema),
  added: Count,
  removed: Count,
  uncounted: Count,
});

export const RunProcessSchema = z.object({
  steps: z.array(ProcessStepSchema),
  counts: ProcessCountsSchema,
  rows: Count,
  /** 到了每段的条数上限，后面的没记。 */
  truncated: z.boolean(),
  /** 没有调用号的调用有几条（老记录）：这几条对不上结果，命令成败写「结果未知」。 */
  legacyCalls: Count,
});
/** 编译期闸：和 task-process.ts 算出来的形状一字不差。 */
export const RUN_PROCESS_MATCHES: Same<z.infer<typeof RunProcessSchema>, RunProcess> = true;

/** 一笔会话切好的步骤：GET /tasks/:taskId/runs/:runId/steps。这一笔跑在记录之前（结束了、一条都没有）是 noRecord；读不到回 503。 */
export const RunStepsResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), running: z.boolean(), process: RunProcessSchema }),
  z.object({ state: z.literal('noRecord') }),
]);

export const RunTallySchema = z.object({
  entries: Count,
  calls: Count,
  commands: Count,
  commandsDone: Count,
  commandsFailed: Count,
  commandsUnknown: Count,
  commandsRunning: Count,
  reads: Count,
  callsFailed: Count,
  editsOk: Count,
  uncounted: Count,
  added: Count,
  removed: Count,
  firstAt: Time.optional(),
  lastAt: Time.optional(),
});
export const RUN_TALLY_MATCHES: Same<z.infer<typeof RunTallySchema>, RunTally> = true;

/** 没读到的原因：页面照写「没读到：<原因>」。 */
const Unread = <S extends string>(state: S) =>
  z.object({ state: z.literal(state), reason: z.string().min(1) });

export const PrFileSchema = z.object({
  path: z.string(),
  /** 二进制文件 git 不给行数，两样都是 null。 */
  added: Count.nullable(),
  removed: Count.nullable(),
  binary: z.boolean(),
});

export const PrHeadSnapshotSchema = z.object({
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  status: z.enum(['complete', 'truncated', 'unavailable']),
  total: Count.nullable(),
  kept: Count,
  reason: z.string().min(1).optional(),
  recordedAt: Time,
});

export const TaskPrSchema = z.object({
  number: z.number().int().positive(),
  branch: z.string().optional(),
  /** merged 已合并 / open 开着 / failed 开着但 CI 红 / closed 关了没合 / unknown 没读到（原因在 note）。 */
  state: z.enum(['merged', 'open', 'failed', 'closed', 'unknown']),
  note: z.string().optional(),
  /** PR 镜像里现在的头；没读到没有。 */
  headSha: z.string().optional(),
  /**
   * 按当前完整 PR 头读 numstat；只有完整快照可回 ok（含成功零文件），不把每次编辑加起来。
   * none＝未采过；unavailable＝读不到、头未知/不符、历史完整性未知、失败或截断，原因和可选 snapshot 说明来源。
   */
  files: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('ok'),
      headSha: z.string(),
      current: z.boolean().optional(),
      items: z.array(PrFileSchema),
      snapshot: PrHeadSnapshotSchema.optional(),
    }),
    Unread('none'),
    Unread('unavailable').extend({ snapshot: PrHeadSnapshotSchema.optional() }),
  ]),
});

/** 一个回合（task_rounds）：一次「动手 → 自测 → 推分支 → CI → 验收」；做成了或返工收场。 */
export const TaskRoundSchema = z.object({
  seq: z.number().int().positive(),
  /** 工作流里的轮数（动手第几轮）。 */
  round: Count,
  /** merged、verify_rejected、ci_red……（引擎的 RoundOutcome）；页面认不出的原样写。 */
  outcome: z.string(),
  tier: z.string().optional(),
  firstModel: z.string().optional(),
  /** 收场时 PR 相对主线的新增行数；没量到不给。 */
  addedLines: Count.optional(),
  flowMode: z.enum(FLOW_MODES).optional(),
  /** 这一轮开始的时刻；老行没有，页面退回第一笔会话的起跑时刻。 */
  startedAt: Time.optional(),
  endedAt: Time,
  /** 这一轮为什么返工、下一轮要改什么；做成了、放弃叫停、老行没有。 */
  reworkSummary: z.string().optional(),
});

/** 引擎在会话外做的事（step_timings）：自测、推分支、开 PR、等 CI、验收、合并……和各种等待。 */
export const EngineStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('activity'),
    /** 活动名（selfCheck、pushBranch、openPr、waitCi、coldVerify……），页面翻成白话。 */
    activity: z.string(),
    attempt: Count,
    startedAt: Time,
    endedAt: Time,
    runMs: Count,
    outcome: z.enum(['ok', 'failed', 'cancelled']),
    errorCode: z.string().optional(),
  }),
  z.object({
    kind: z.literal('wait'),
    /** 等什么：human、slot、quota……。 */
    waitFor: z.string(),
    detail: z.string().optional(),
    startedAt: Time,
    endedAt: Time,
    waitMs: Count,
  }),
]);

export const TaskOverviewSchema = z.object({
  /** 这张单关联的 PR（段流水里的、子任务里的），按号排。 */
  prs: z.array(TaskPrSchema),
  /** 命令、读文件的计数：每一笔一行（库里 GROUP BY run_id 一条查出来）加整张单合计。 */
  tally: z.discriminatedUnion('state', [
    z.object({ state: z.literal('ok'), total: RunTallySchema, byRun: z.record(Id, RunTallySchema) }),
    Unread('unavailable'),
  ]),
  /** 最新汇报：最近一笔动手的最后一条主会话助手的话（不取 result）。none＝没有（原因写明）。 */
  report: z.discriminatedUnion('state', [
    z.object({ state: z.literal('ok'), text: z.string(), at: Time, runId: Id }),
    Unread('none'),
    Unread('unavailable'),
  ]),
  rounds: z.discriminatedUnion('state', [
    z.object({ state: z.literal('ok'), items: z.array(TaskRoundSchema) }),
    Unread('unavailable'),
  ]),
  engineSteps: z.discriminatedUnion('state', [
    z.object({ state: z.literal('ok'), items: z.array(EngineStepSchema) }),
    Unread('unavailable'),
  ]),
});

export const TaskDetailResponse = z.object({
  task: TaskSchema,
  repo: RepoSchema,
  subtasks: z.array(BoardSubtaskSchema),
  /** 三段（runs 表）的流水，按起跑先后：task_id 对上的，加上 task_id 没记、按单号兜底的（matchedBy 标明）。 */
  segmentRuns: z.array(SegmentRunSchema),
  /** 用量：三段的流水整张合计、按模型、按段（每段再按模型）。 */
  usage: TaskUsageSchema,
  /** 这张单每段指定的模型（动手、验收）。 */
  routePins: TaskRoutePinsSchema,
  /** 任务页的概览和过程（#3140）。老后端、老环境推来的详情没有，页面写「这台没给」，不画 0。 */
  overview: TaskOverviewSchema.optional(),
});

// —— 一段会话的过程记录（#1640）——
// 引擎在三段会话跑的时候按条记进 run_transcript（挂在 runs 那一行上）；任务详情每段的「会话内容」按序号往后读。
// GET /tasks/:taskId/runs/:runId/transcript?after=<seq>&limit=<n>：runId 就是 segmentRuns[].id；after 不给从头读，
// 给了回序号大于它的；在跑的段拿上一次回的 nextAfter 当 after 增量刷新。读不到（库不通、没接上）回 503，不拿空列表顶。

export const TranscriptKindSchema = z.enum(TRANSCRIPT_KINDS);

export const TranscriptEntrySchema = z.object({
  /** 这一段里的序号，从 0 起、连续。 */
  seq: z.number().int().min(0),
  at: Time,
  kind: TranscriptKindSchema,
  /** 内容（提示词、助手的话、工具的输入摘要或结果开头、报错、结论）；已打码、已截断。 */
  text: z.string(),
  /** 工具名：tool_call、tool_result 才有。 */
  tool: z.string().optional(),
  /** 成没成：tool_result、result 才有。 */
  ok: z.boolean().optional(),
  /** 截断了会带 { truncated: true, originalChars }；还可能带别的补充（退出原因……）。 */
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const RunTranscriptQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(TRANSCRIPT_PAGE_MAX).default(TRANSCRIPT_PAGE_DEFAULT),
});

export const RunTranscriptResponse = z.object({
  entries: z.array(TranscriptEntrySchema),
  /** 下次读从这个序号往后（= 这次最后一条的序号）；这次一条没有时原样回 after（没给 after 就是 null）。 */
  nextAfter: z.number().int().min(0).nullable(),
  /** 这一段已经结束、而且 nextAfter 之后没有了：页面可以不再刷新。在跑的段恒为 false。 */
  done: z.boolean(),
  /**
   * true = 这一段已经结束、库里一条都没有：它跑在记录会话内容之前（或一条都没写进去）。和「读不到」不同，读不到回 503。
   * 在跑的段还没有条目不算（noRecord 为 false，entries 为空，等着刷新）。
   */
  noRecord: z.boolean(),
});

// —— 发给工作流的信号 ——

export const TaskActionRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('pause'),
    reason: z.string().max(500).optional(),
    /** soft（默认）＝手上这一段做完再停；hard＝动手的会话马上停下（继续后原树原分支接着干）。 */
    mode: z.enum(['soft', 'hard']).optional(),
  }),
  z.object({
    action: z.literal('resume'),
    /** 为什么继续：总轮数到顶交还本机的停下（#3603）必填，别的停下可不填。随「继续」信号交给工作流。 */
    reason: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal('stop'), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('redo') }),
  z.object({
    action: z.literal('reroute'),
    routeId: Id,
    /** 只换某个子任务的；不填 = 换这个需求当前在跑的那一个会话。 */
    subtaskId: Id.optional(),
    reason: z.string().max(500).optional(),
  }),
]);
export const TaskActionResponse = z.object({ ok: z.literal(true) });
