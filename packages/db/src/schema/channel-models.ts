// 渠道自己认的模型（#1302）：额度读取顺手读名册，记在这里，跟目录比出差集。
// 不自动改目录。读失败只改「最近一次读」那一行，不动已经看见的模型，免得一次没读成被说成「渠道里已经没有」。
import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { channels } from './catalog.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/** 某个渠道里见过的模型串。消失的也留着：最近一次读成的时刻对得上 last_seen_at 的才算「现在还认」。 */
export const channelSeenModels = pgTable(
  'channel_seen_models',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    /** 渠道自己的模型串，跟路由的上游串、别名原样比，不归一。 */
    modelKey: text('model_key').notNull(),
    firstSeenAt: timestamp('first_seen_at', tz).notNull(),
    lastSeenAt: timestamp('last_seen_at', tz).notNull(),
  },
  (t) => [
    primaryKey({ name: 'channel_seen_models_pk', columns: [t.channelId, t.modelKey] }),
    check('channel_seen_models_key_nonempty', sql`length(btrim(${t.modelKey})) > 0`),
    check('channel_seen_models_last_after_first', sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
  ],
);

/**
 * 每个渠道最近一次读名册的结果。失败也写在这里：页面看到失败就不能说「都对得上」，
 * 也不能拿更早一次读成的名单去报「新增 / 消失」。
 */
export const channelModelReads = pgTable(
  'channel_model_reads',
  {
    channelId: text('channel_id')
      .primaryKey()
      .references(() => channels.id),
    attemptedAt: timestamp('attempted_at', tz).notNull(),
    ok: boolean('ok').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
  },
  (t) => [
    check(
      'channel_model_reads_error_matches_ok',
      sql`(${t.ok} = true and ${t.errorCode} is null and ${t.errorMessage} is null) or (${t.ok} = false and coalesce(${t.errorCode}, '') <> '' and coalesce(${t.errorMessage}, '') <> '')`,
    ),
  ],
);
