// 渠道顺延（#1089 第二批、#1118）：运行中失败自动换同一个模型的下一个渠道，换了几次、每次换到谁、为什么落库。
//
// - channel_attempts：每一次起会话的尝试一行（谁、哪个渠道、成没成、错误类型、多久）。写它的是 runSegment
//   （packages/engine/src/real/task-segment.ts）：成功、失败都记。
// - channel_states：渠道维度的「现在能不能用」，一个渠道一行、覆盖写。失败分流判这一条路由的错、该换渠道时标 disabled
//   （写原因和顺到谁），路由探针探通了改回 ok。选路（db 的 queries/candidates.ts 的 evaluateRoutes）读它：disabled 的渠道
//   下所有路由带 channel-failed 这个挡因，不被选；读不到这张表就抛，不当成全 ok。
//   和 routes.probe_state 分开：那个是一条路由最近一次探针的结论，这个是渠道整体的近态。
// - 没有行 = 这个渠道没出过事 = ok；不用上线时先给每个渠道写一行。

import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { channels, models, routes } from './catalog.ts';
import { runs } from './runs.ts';
import { tasks } from './work.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/** ok 能用；disabled 运行中失败被标下来，等探针探通改回。 */
export const CHANNEL_STATE_VALUES = ['ok', 'disabled'] as const;
export type ChannelState = (typeof CHANNEL_STATE_VALUES)[number];

export const channelStates = pgTable(
  'channel_states',
  {
    channelId: text('channel_id')
      .primaryKey()
      .references(() => channels.id, { onDelete: 'cascade' }),
    status: text('status').$type<ChannelState>().notNull(),
    /** 为什么标成 disabled（失败分流的原因，带上游原文摘要）；disabled 必须有。改回 ok 时写一句恢复的依据。 */
    reason: text('reason'),
    /**
     * 引发这次 disabled 的那条路由：探针探通的恰好是它才改回 ok（同一个渠道别的路由探通不说明它修好了）。
     * 路由被删了置空：置空后渠道下任一条路由探通就改回，不让渠道永远卡着。
     */
    failedRouteId: text('failed_route_id').references(() => routes.id, { onDelete: 'set null' }),
    /** 顺到谁：这次失败之后选路派到的渠道和模型（同一个模型的下一个渠道；这个模型的渠道都用尽才会是别的模型）。还没派出去为空。 */
    fallbackChannelId: text('fallback_channel_id').references(() => channels.id, { onDelete: 'set null' }),
    fallbackModelId: text('fallback_model_id').references(() => models.id, { onDelete: 'set null' }),
    /** 路由探针最近一次探过这个渠道下某条路由的时刻（页面算「下次探测」用）；没探过为空。 */
    lastProbedAt: timestamp('last_probed_at', tz),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    /** 这一次 disabled 是几点标上的（重复标不重置，改回 ok 清空）。 */
    flaggedAt: timestamp('flagged_at', tz),
  },
  (t) => [
    check('channel_states_status_known', sql`${t.status} in ('ok', 'disabled')`),
    // 标成 disabled 必须写原因和时间：没写原因的「不可用」页面无从解释。
    check(
      'channel_states_disabled_has_reason',
      sql`${t.status} = 'ok' or (coalesce(${t.reason}, '') <> '' and ${t.flaggedAt} is not null)`,
    ),
    // 顺到谁的渠道和模型同记同空：只记一半读的一方就得猜。
    check(
      'channel_states_fallback_together',
      sql`(${t.fallbackChannelId} is null) = (${t.fallbackModelId} is null)`,
    ),
  ],
);

/**
 * 每一次起会话的尝试。一条 runs 行是一次尝试（每次换渠道、重试都是新的 runs 行），所以这里按任务排序：
 * attempt_idx 是这张单从 1 起的第几次（写入时由库算，queries/channel-fallback.ts 的 recordChannelAttempt）。
 */
export const channelAttempts = pgTable(
  'channel_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 对应的 runs 行；会话没起来（spawn 失败）没有 runs 行为空。runs 行删了尝试照留。 */
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /** 哪张单（tasks.id）；不属于哪张单的为空（此时 attempt_idx 恒为 1）。 */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    attemptIdx: bigint('attempt_idx', { mode: 'number' }).notNull(),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    routeId: text('route_id')
      .notNull()
      .references(() => routes.id),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    /** 失败归哪类（会话没跑成的原因码：quota_exhausted、network_error、wall_clock_timeout、spawn_failed……）；成了为空。表不约束取值。 */
    errorType: text('error_type'),
    /** 失败原文摘要（最多几百字）；失败必须有，成了为空。 */
    message: text('message'),
    startedAt: timestamp('started_at', tz).notNull(),
    endedAt: timestamp('ended_at', tz).notNull(),
    /** 全程毫秒数（ended_at - started_at）。 */
    durationMs: bigint('duration_ms', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check('channel_attempts_idx_positive', sql`${t.attemptIdx} >= 1`),
    check(
      'channel_attempts_failed_has_reason',
      sql`${t.errorType} is null or coalesce(${t.message}, '') <> ''`,
    ),
    check('channel_attempts_ended_after_start', sql`${t.endedAt} >= ${t.startedAt}`),
    check('channel_attempts_duration_nonneg', sql`${t.durationMs} >= 0`),
    index('channel_attempts_task_idx').on(t.taskId, t.attemptIdx),
    index('channel_attempts_channel_idx').on(t.channelId, t.createdAt),
  ],
);
