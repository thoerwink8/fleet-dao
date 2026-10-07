// v3 三段一条龙每段跑一次的记录（scope / manual / verify），#555-3（#599）。
// 结构和 packages/engine/src/runner/not-wired.ts 的 RunRecord 一对一钉死：写入那一端先 EmptyRunsWriter 占位
// （_tmp/runs-not-wired/<日期>.jsonl），本切片建表并让 verify 的那一端真实写入；runner 装配换成真 RunsWriter
// 是 #556-4/-5/-6 的活。
//
// 关键约束：
// - 三段各跑一次，字段照 RunRecord：issueNumber / channel / token / costUsd / memoryPeakMb 读不到就不写，
//   **不拿 0 顶**（#216）；没读到就是 NULL，不是 0。
// - segment 是「scope | manual | verify」三择一（#554-1 的 RunRecord segment 枚举），写其他任何值都不收。
// - outcome 是「done | timeout | killed | spawn_failed | admission_blocked | failed | org_switch」（#554-1 的枚举，
//   org_switch 是切号先停下这一段、切完在原分支上重跑，#59），还在跑的为空；结束了（ended_at 非空）就必须有 outcome，
//   反之亦然——和 session_runs_outcome_iff_ended 同一个做法。
// - retryOf 自引用，指到不存在的行要拒收（外键）。
// - 一次性会话开跑就写一行「没结束」的（ended_at、outcome 都空），收场时补完（#157）：切号数带组织类型的池上还没结束的会话、
//   选路数池的并发（#735）都靠 route_id 连到池（db 的 queries/pool-runs.ts），没写 route_id 的行两边都看不见。
// - tier 是派工档，叫法和取值照 packages/engine/src/runner/tier.ts 的 TierEnum（fast | medium | heavyweight），
//   引擎测试 test/runner/tier.test.ts 钉着两边一致；只有动手段分档（决定 0010 第 3 条），对题、验收（冷调用）不分档，留空。
// - route_outcome 是这一次算不算路由的账（ok | fail | neutral），和 session_runs.route_outcome 同一个口径，选路的熔断、战绩
//   两张表并起来读（queries/pool-runs.ts，#758）。收场时由引擎判好写下（runner/evidence.ts）；还在跑的不许有；空的（老行、
//   Fusion 验证那一笔流水）按不算账读，不进熔断、战绩。
// 表名就叫 runs（和 Fusion 的 sessionRuns 分开：那张老表还有读方，没删）。
//
// pool_reservations（#757）是一段选定路由之后、写下开跑那一行之前预占着的池的名额：一行就是「这张单的这一段已经派到这条
// 路由上、还在建树或等内存」。怎么占、怎么交接、怎么放都在 queries/pool-runs.ts，别处不写这张表。（和账号池整池暂停的
// 「pool-hold:<池>」提醒是两回事。）
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { models, routes } from './catalog.ts';
import { tasks } from './work.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/** v3 的三段：对题（scope）、动手（manual）、验收（verify）。和 #554-1 RunRecord.segment 完全一致。 */
export const RUN_SEGMENTS = ['scope', 'manual', 'verify'] as const;
export type RunSegment = (typeof RUN_SEGMENTS)[number];

/** 跑一场的结局：和 #554-1 RunRecord.outcome 完全一致；还在跑的不写（NULL）。 */
export const RUN_OUTCOME_VALUES = [
  'done',
  'timeout',
  'killed',
  'spawn_failed',
  'admission_blocked',
  'failed',
  'org_switch',
] as const;
export type RunOutcomeValue = (typeof RUN_OUTCOME_VALUES)[number];

/** 派工档：和 engine runner/tier.ts 的 TierEnum 完全一致（快档 / 中档 / 主力档）。没记的不写（NULL）。 */
export const RUN_TIERS = ['fast', 'medium', 'heavyweight'] as const;
export type RunTier = (typeof RUN_TIERS)[number];

/**
 * 这一次算不算这条路由的账（喂选路的熔断和战绩）：ok = 跑通了；fail = 失败分流判是路由的错；neutral = 不算（我们停的、
 * 没起来、内存放不下、分流判不是路由的错）。和 session_runs.route_outcome 取值、口径都一样。
 */
export const RUN_ROUTE_OUTCOMES = ['ok', 'fail', 'neutral'] as const;
export type RunRouteOutcome = (typeof RUN_ROUTE_OUTCOMES)[number];

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 哪一段：scope | manual | verify（#554-1 RunRecord.segment）。 */
    segment: text('segment').$type<RunSegment>().notNull(),
    /** 需求（tasks）；不属于任何需求的会话（巡逻、实验）为空——collections 外键不查空。 */
    taskId: uuid('task_id').references(() => tasks.id),
    /** 需求单号（GitHub issue #）；和 taskId 一起读不到就一起空。 */
    issueNumber: integer('issue_number'),
    /** 挑好的模型（路由给的 modelId；不是家族的）。 */
    model: text('model').notNull(),
    /** 挑好的渠道（poolId / routeId 的「渠道」那半截）；读不到不给。 */
    channel: text('channel'),
    /**
     * 跑在哪条路由上（选路给的 routeId）：切号靠它认出这一段跑在哪个池、那个池挂不挂组织（#157），选路靠它把这一段算进池的并发
     * （#735）。老行、不经选路起的为空；指到不存在的路由拒收（外键），免得连不到池、把在跑的会话漏数。
     */
    routeId: text('route_id').references(() => routes.id),
    /** 派工档（动手段按改动面分的档）；对题、验收不分档，没记的也是空——读的一方按段判是「不分档」还是「没记」。 */
    tier: text('tier').$type<RunTier>(),
    /** 起止；ended_at 还在跑的为空（和 outcome 的空一一对应，见约束）。 */
    startedAt: timestamp('started_at', tz).notNull(),
    endedAt: timestamp('ended_at', tz),
    /** 结局；和 ended_at 的空一一对应，还在跑就是空。 */
    outcome: text('outcome').$type<RunOutcomeValue>(),
    /** 这一次算不算这条路由的账（RUN_ROUTE_OUTCOMES）：收场时写；还在跑的为空，空的结束行按不算账读。 */
    routeOutcome: text('route_outcome').$type<RunRouteOutcome>(),
    /** token / 花费 / 内存：读不到不给，不当 0（#216）。 */
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6, mode: 'number' }),
    /** 内存峰值（MiB）：只对挂在 cgroup 里的会话可读；本机不给。 */
    memoryPeakMb: integer('memory_peak_mb'),
    /** 失败原因（exit code、错误消息），outcome != 'done' 时给。 */
    failureReason: text('failure_reason'),
    /** 这一段交出来的 PR（manual / verify 才多半有；scope 也可能有：对题头可能没动主线就空）。 */
    prNumber: integer('pr_number'),
    /** 会话干活的分支。 */
    branch: text('branch'),
    /** Temporal 工作流编号（Fusion 那条线或 v3 三段那条线）；跑外头实验的会话可空。 */
    workflowId: text('workflow_id'),
    /** Temporal 的 run id（同一 workflowId 换过 run 才分叉）。 */
    temporalRunId: text('temporal_run_id'),
    /** 这一笔是重试（re-try）哪一笔：指到 runs.id。重试的字面意思就是「作废上一次、重新跑一次」。 */
    retryOf: uuid('retry_of'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check('runs_segment_known', sql`${t.segment} in ('scope', 'manual', 'verify')`),
    check('runs_tier_known', sql`${t.tier} is null or ${t.tier} in ('fast', 'medium', 'heavyweight')`),
    check(
      'runs_outcome_known',
      sql`${t.outcome} is null or ${t.outcome} in ('done', 'timeout', 'killed', 'spawn_failed', 'admission_blocked', 'failed', 'org_switch')`,
    ),
    //故事和 session_runs_outcome_iff_ended 一样：结束了就必须有结局，有结局就必须已结束。
    check('runs_outcome_iff_ended', sql`(${t.endedAt} is null) = (${t.outcome} is null)`),
    check(
      'runs_route_outcome_known',
      sql`${t.routeOutcome} is null or ${t.routeOutcome} in ('ok', 'fail', 'neutral')`,
    ),
    // 还在跑的没有「算不算路由的账」：结论只在收场时下
    check('runs_route_outcome_after_end', sql`${t.routeOutcome} is null or ${t.endedAt} is not null`),
    check('runs_ended_after_start', sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
    check('runs_issue_positive', sql`${t.issueNumber} is null or ${t.issueNumber} > 0`),
    check('runs_pr_positive', sql`${t.prNumber} is null or ${t.prNumber} > 0`),
    check(
      'runs_usage_nonneg',
      sql`coalesce(${t.inputTokens}, 0) >= 0 and coalesce(${t.outputTokens}, 0) >= 0 and coalesce(${t.cacheReadTokens}, 0) >= 0 and coalesce(${t.cacheWriteTokens}, 0) >= 0 and coalesce(${t.costUsd}, 0) >= 0`,
    ),
    check('runs_memory_nonneg', sql`${t.memoryPeakMb} is null or ${t.memoryPeakMb} >= 0`),
    index('runs_task_idx').on(t.taskId, t.createdAt),
    index('runs_segment_created_idx').on(t.segment, t.createdAt),
    index('runs_workflow_idx').on(t.workflowId),
    index('runs_pr_idx').on(t.prNumber),
    // 在途的那一截（还没结束的）按段查：健康页「这一段最久在跑哪一笔」。
    index('runs_open_idx').on(t.segment).where(sql`${t.endedAt} is null`),
    // retry_of 是上一次的自己：自引用，指到不存在的行要拒收。
    foreignKey({
      name: 'runs_retry_of_self_fk',
      columns: [t.retryOf],
      foreignColumns: [t.id],
    }),
  ],
);

/** 经选路、会预占池的名额的两段：动手、验收（对题不经选路，engine 的 task-contract.ts 的 SEGMENT_STAGE）。 */
export const ROUTED_SEGMENTS = ['manual', 'verify'] as const;
export type RoutedSegment = (typeof ROUTED_SEGMENTS)[number];

/**
 * 选定了路由、还没写下开跑那一行的一段预占着的池的名额（#757）。选路数池的并发时和 runs、session_runs 里开着的行一起数
 * （queries/pool-runs.ts 的 openPoolRuns，算进 reserved「选定了还没开工」）：不数它，一批单同时选路都看见池空着、都派过去，
 * 内存一放开一起起会话，把拼车池派超。一张单的一段同一时刻只预占一个（再选路就换掉旧的）；过了 expires_at 就不算（建树、
 * 等内存卡死了不能一直占着）。都是一时的状态：单子、路由删了跟着删，引擎重启整表清掉。
 */
export const poolReservations = pgTable(
  'pool_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 哪张单（tasks.id）。 */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** 哪一段（ROUTED_SEGMENTS）。 */
    segment: text('segment').$type<RoutedSegment>().notNull(),
    /** 选中的路由：经它连到池，和 runs.route_id 一样。 */
    routeId: text('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    /** 选中的时刻。 */
    reservedAt: timestamp('reserved_at', tz).notNull(),
    /** 过了这一刻就不算占着（这一段开跑时再按当时的空位排）。 */
    expiresAt: timestamp('expires_at', tz).notNull(),
  },
  (t) => [
    check('pool_reservations_segment_routed', sql`${t.segment} in ('manual', 'verify')`),
    check('pool_reservations_expires_after_reserved', sql`${t.expiresAt} > ${t.reservedAt}`),
    uniqueIndex('pool_reservations_task_segment_uq').on(t.taskId, t.segment),
    index('pool_reservations_route_idx').on(t.routeId),
  ],
);

/**
 * 人给一张单的一段（动手、验收）指定的模型（驾驶舱改版 2026-10-07：「每个任务能点进去随意切换模型」）。驾驶舱单子页写
 * （api 的 task-route-pins.ts，和操作记录同一个事务），引擎每次给这张单的这一段选路时现读（engine 的 real/store-ports.ts）：
 * 只派这个模型（钉了路由的只派那条）的路由，派不出就等或停下等人、写明原因，不悄悄换别的；在跑的那一轮不打断。
 * 一张单一段一行，改就覆盖写；model_id 为空 = 清掉了指定、回到自动（不删行：谁什么时候清的留着）。
 */
export const taskRoutePins = pgTable(
  'task_route_pins',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** 哪一段（ROUTED_SEGMENTS）：对题不经选路，指定不了。 */
    segment: text('segment').$type<RoutedSegment>().notNull(),
    /** 指定的模型；空 = 自动（按路由两层的顺序）。 */
    modelId: text('model_id').references(() => models.id),
    /** 还钉到这个模型下的哪条路由；空 = 这个模型下按路由顺序挑。只能是这个模型的路由（下面的复合外键）。 */
    routeId: text('route_id'),
    /** 谁定的（驾驶舱用户编号）。 */
    setBy: text('set_by').notNull(),
    setAt: timestamp('set_at', tz).notNull(),
    reason: text('reason'),
  },
  (t) => [
    primaryKey({ name: 'task_route_pins_pk', columns: [t.taskId, t.segment] }),
    check('task_route_pins_segment_routed', sql`${t.segment} in ('manual', 'verify')`),
    check('task_route_pins_route_needs_model', sql`${t.routeId} is null or ${t.modelId} is not null`),
    // 钉的路由要挂在钉的模型下（routes_id_model_unique）：不许钉一条别的模型的路由
    foreignKey({
      name: 'task_route_pins_route_of_model_fk',
      columns: [t.routeId, t.modelId],
      foreignColumns: [routes.id, routes.modelId],
    }),
  ],
);
