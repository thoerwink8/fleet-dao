// 提醒是一件活（design 15.3「谁在处理」）：一条提醒一张主跟进单（alert_work）、Alertmanager 式的静默（alert_silences）。
// 谁在处理不另记：就是跟进单上的认领（seat.ts 的 issue_claims）；状态从认领、PR 镜像、发布记录读时现算
// （@fleet-dao/core 的 alert-work.ts）。读写在 queries/alert-work.ts。
// 改这里之前必须知道：
// - alert_work 只记「没挂任务」或「挂了别的单」的：有 task_id 又没另挂的，跟进单就是那个任务的单，这里没有行。
//   原来「提醒派单」自动开小单写 source='engine'、`alert claim --issue` 手动换单写 source='claim'，2026-09-28
//   起这两条写路都删了（#445，噪音比防住的事故还多）：这张表和历史行都留着给驾驶舱读，只是不会再有新行写进来。
// - 静默的到期由库的 now() 定（建的时候 ends_at = now() + 分钟数），最长 7 天由约束钉死：忘了撤也不会一直压着。
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { notifications } from './ops.ts';
import { repos } from './work.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/** 一条提醒的主跟进单（k8s ownerReferences 里 controller=true 的那一个：同一时刻只一张）。 */
export const alertWork = pgTable(
  'alert_work',
  {
    notificationId: uuid('notification_id')
      .primaryKey()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id),
    issueNumber: integer('issue_number').notNull(),
    /** engine = 原「提醒派单」开的小单；claim = 原 `alert claim --issue` 挂的（两条写路都在 #445 删了，只剩历史行）。 */
    source: text('source').$type<'engine' | 'claim'>().notNull(),
    /** 谁挂的：历史上是 engine:alert-dispatch，或 <机器名>/<会话号>。 */
    linkedBy: text('linked_by').notNull(),
    linkedAt: timestamp('linked_at', tz).notNull().defaultNow(),
    /** 为什么挂这张（换单时写原来是哪张、为什么换）。 */
    note: text('note'),
  },
  (t) => [
    check('alert_work_issue_number_positive', sql`${t.issueNumber} > 0`),
    check('alert_work_source_known', sql`${t.source} in ('engine', 'claim')`),
    index('alert_work_issue_idx').on(t.repoId, t.issueNumber),
  ],
);

/**
 * 静默（Alertmanager 的 silence：createdBy、comment、startsAt/endsAt）：对得上的提醒不升级、不开跟进单、显示「已静默」，
 * 提醒本身照旧开着、条件没了照旧自动撤。match_kind = key 是一条提醒的键，prefix 是一类（以冒号结尾）。
 */
export const alertSilences = pgTable(
  'alert_silences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchKind: text('match_kind').$type<'key' | 'prefix'>().notNull(),
    match: text('match').notNull(),
    /** 为什么：谁拍的、为什么不用处理。 */
    comment: text('comment').notNull(),
    /** 谁建的：<机器名>/<会话号>，或创始人（root 手敲时带原话）。 */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    endsAt: timestamp('ends_at', tz).notNull(),
    /** 提前撤：什么时候、谁、为什么。 */
    expiredAt: timestamp('expired_at', tz),
    expiredBy: text('expired_by'),
    expireNote: text('expire_note'),
  },
  (t) => [
    check('alert_silences_match_kind_known', sql`${t.matchKind} in ('key', 'prefix')`),
    check(
      'alert_silences_match_shape',
      sql`length(${t.match}) between 1 and 300 and ${t.match} !~ '\\s' and (${t.matchKind} = 'key' or (length(${t.match}) >= 4 and right(${t.match}, 1) = ':'))`,
    ),
    check('alert_silences_comment_not_blank', sql`length(btrim(${t.comment})) > 0`),
    check('alert_silences_ends_after_created', sql`${t.endsAt} > ${t.createdAt}`),
    check('alert_silences_at_most_7_days', sql`${t.endsAt} <= ${t.createdAt} + interval '7 days'`),
    check(
      'alert_silences_expired_shape',
      sql`(${t.expiredAt} is null) = (${t.expiredBy} is null) and (${t.expiredAt} is null) = (${t.expireNote} is null)`,
    ),
    index('alert_silences_live_idx').on(t.endsAt).where(sql`${t.expiredAt} is null`),
  ],
);
