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
// - 一次性会话开跑就写一行「没结束」的（ended_at、outcome 都空），收场时补完（#157）：切号数带组织类型的池上还没结束的会话
//   （db 的 session-org.ts）靠 route_id 连到池，没写 route_id 的行切号看不见。
// 表名就叫 runs（和 Fusion 的 sessionRuns / verifyRounds 分开：Fusion 那两张老表本切片不动）。
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { routes } from './catalog.ts';
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
     * 跑在哪条路由上（选路给的 routeId）：切号靠它认出这一段跑在哪个池、那个池挂不挂组织（#157）。老行、不经选路起的为空；
     * 指到不存在的路由拒收（外键），免得切号连不到池、把在跑的会话漏数。
     */
    routeId: text('route_id').references(() => routes.id),
    /** 起止；ended_at 还在跑的为空（和 outcome 的空一一对应，见约束）。 */
    startedAt: timestamp('started_at', tz).notNull(),
    endedAt: timestamp('ended_at', tz),
    /** 结局；和 ended_at 的空一一对应，还在跑就是空。 */
    outcome: text('outcome').$type<RunOutcomeValue>(),
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
    check(
      'runs_outcome_known',
      sql`${t.outcome} is null or ${t.outcome} in ('done', 'timeout', 'killed', 'spawn_failed', 'admission_blocked', 'failed', 'org_switch')`,
    ),
    //故事和 session_runs_outcome_iff_ended 一样：结束了就必须有结局，有结局就必须已结束。
    check('runs_outcome_iff_ended', sql`(${t.endedAt} is null) = (${t.outcome} is null)`),
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
