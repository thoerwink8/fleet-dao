// 飞书网关要的四张表：随手记的草稿、关注、推送的送达状态、卡片登记。接口约定在 @fleet-dao/shared 的 feishu-api.ts。
// 收到的话（按飞书消息编号）和卡上「改一下」（按请求编号）的幂等记录放在 idempotency_keys（ops.ts），不另建表。
// 取值表不用 pg 枚举，用文字加检查约束：卡片种类以后还会加，删改检查约束比删枚举值容易。
// 值表和约定里的枚举逐一对齐（valuesOf）：约定加了值这里没加，tsc 当场报错。
import type {
  FeishuCardKindSchema,
  FeishuDraftSchema,
  FeishuMessageRequest,
  FeishuOutboxAckSchema,
} from '@fleet-dao/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { valuesOf } from './enums.ts';
import { users } from './ops.ts';
import { repos, tasks } from './work.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export type FeishuDraftStatus = z.infer<typeof FeishuDraftSchema>['status'];
export type FeishuChatType = z.infer<typeof FeishuMessageRequest>['chatType'];
export type FeishuCardKind = z.infer<typeof FeishuCardKindSchema>;
export type FeishuAckStatus = z.infer<typeof FeishuOutboxAckSchema>['result']['status'];

export const FEISHU_DRAFT_STATUSES = valuesOf<FeishuDraftStatus>()(['open', 'confirmed']);
export const FEISHU_CHAT_TYPES = valuesOf<FeishuChatType>()(['p2p', 'group']);
export const FEISHU_CARD_KINDS = valuesOf<FeishuCardKind>()([
  'draft',
  'progress',
  'board',
  'list',
  'answer',
  'decision',
  'alert',
  'daily',
  'follow',
  'ask',
]);
export const FEISHU_ACK_STATUSES = valuesOf<FeishuAckStatus>()([
  'sent',
  'updated',
  'deferred',
  'dropped',
  'failed',
]);

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '));

/**
 * 随手记的草稿：一句话 →「我理解为」→ 点确认。确认后不再改（开成任务后要改需求去驾驶舱）。
 * 确认了还没有 task_id 就是「待开单」：开 issue、建任务、拉起工作流的那一步还没做成，后端定时补开，不丢。
 * 「改一下」的补充整句接在 raw_text 后面（没有长度上限）；understanding 放不下时截旧的。
 */
export const feishuDrafts = pgTable(
  'feishu_drafts',
  {
    /** 由应用先定好：收到的话的幂等记录里要带上它，和草稿同一事务写。 */
    id: uuid('id').primaryKey(),
    /** 每改一次加 1；确认时带上看到的那一版。 */
    revision: integer('revision').notNull().default(1),
    status: text('status').$type<FeishuDraftStatus>().notNull().default('open'),
    /** 记下这张草稿的那条飞书消息：同一条消息只记一个草稿。 */
    sourceMessageId: text('source_message_id').notNull().unique(),
    chatType: text('chat_type').$type<FeishuChatType>().notNull(),
    rawText: text('raw_text').notNull(),
    understanding: text('understanding').notNull(),
    unsure: boolean('unsure').notNull(),
    /** 放在哪个仓；空 = 没判出来，确认时必须选。 */
    repoId: uuid('repo_id').references(() => repos.id),
    proposedBy: uuid('proposed_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    confirmedAt: timestamp('confirmed_at', tz),
    /** 开成的任务。 */
    taskId: uuid('task_id').references(() => tasks.id),
    /** 开单试过几次、最近一次为什么没成、什么时候试的（补开按它退避）。 */
    openAttempts: integer('open_attempts').notNull().default(0),
    openError: text('open_error'),
    openTriedAt: timestamp('open_tried_at', tz),
  },
  (t) => [
    check('feishu_drafts_status_known', sql`${t.status} in (${inList(FEISHU_DRAFT_STATUSES)})`),
    check('feishu_drafts_chat_type_known', sql`${t.chatType} in (${inList(FEISHU_CHAT_TYPES)})`),
    check('feishu_drafts_revision_positive', sql`${t.revision} >= 1`),
    check('feishu_drafts_understanding_length', sql`char_length(${t.understanding}) between 1 and 1000`),
    // 确认了就必须写明谁、什么时候、放哪个仓；没确认的不许有确认人和确认时刻。
    check(
      'feishu_drafts_confirm_shape',
      sql`(${t.status} = 'confirmed') = (${t.confirmedBy} is not null) and (${t.status} = 'confirmed') = (${t.confirmedAt} is not null) and (${t.status} <> 'confirmed' or ${t.repoId} is not null)`,
    ),
    check('feishu_drafts_task_needs_confirm', sql`${t.taskId} is null or ${t.status} = 'confirmed'`),
    check('feishu_drafts_open_attempts_nonneg', sql`${t.openAttempts} >= 0`),
    index('feishu_drafts_to_open_idx')
      .on(t.confirmedAt)
      .where(sql`${t.status} = 'confirmed' and ${t.taskId} is null`),
  ],
);

/** 谁关注了哪个需求。取消关注只把 following 改成 false，不删行。 */
export const feishuFollows = pgTable(
  'feishu_follows',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    following: boolean('following').notNull(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.userId] })],
);

/**
 * 推给飞书的每件事的送达状态。推什么不存在这里：内容每次从源头（asks、notifications）现算，这里只记
 * 「现在是第几版、这一版内容的指纹、网关回执到哪一版、上次送到哪张卡」。内容一变（指纹不同）版本加 1，
 * 网关按版本原地更新那张卡；回执只认当前这一版。
 */
export const feishuOutbox = pgTable(
  'feishu_outbox',
  {
    /** 例如 ask:<asks.id>、notification:<notifications.id>。 */
    id: text('id').primaryKey(),
    revision: integer('revision').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    /** 最近一条回执回的是哪一版、结果、原因（不发了的原因、没发成的错误）。 */
    ackRevision: integer('ack_revision'),
    ackStatus: text('ack_status').$type<FeishuAckStatus>(),
    ackReason: text('ack_reason'),
    ackedAt: timestamp('acked_at', tz),
    /** 推迟（免打扰）或没发成：这之前不再给网关。 */
    holdUntil: timestamp('hold_until', tz),
    /** 飞书那边没发成的次数（累计）。 */
    failures: integer('failures').notNull().default(0),
    /** 上次送到的卡（「发了」「改了」的回执记的）。 */
    deliveredMessageId: text('delivered_message_id'),
    deliveredChatId: text('delivered_chat_id'),
    deliveredAt: timestamp('delivered_at', tz),
    deliveredRevision: integer('delivered_revision'),
  },
  (t) => [
    check('feishu_outbox_revision_positive', sql`${t.revision} >= 1`),
    check(
      'feishu_outbox_ack_status_known',
      sql`${t.ackStatus} is null or ${t.ackStatus} in (${inList(FEISHU_ACK_STATUSES)})`,
    ),
    check(
      'feishu_outbox_ack_shape',
      sql`(${t.ackRevision} is null) = (${t.ackStatus} is null) and (${t.ackRevision} is null) = (${t.ackedAt} is null) and (${t.ackRevision} is null or ${t.ackRevision} between 1 and ${t.revision})`,
    ),
    check(
      'feishu_outbox_hold_only_when_waiting',
      sql`${t.holdUntil} is null or ${t.ackStatus} in ('deferred', 'failed')`,
    ),
    check(
      'feishu_outbox_delivered_shape',
      sql`(${t.deliveredMessageId} is null) = (${t.deliveredChatId} is null) and (${t.deliveredMessageId} is null) = (${t.deliveredAt} is null)`,
    ),
    check('feishu_outbox_failures_nonneg', sql`${t.failures} >= 0`),
  ],
);

/**
 * 卡片登记：网关发出的每条消息一行（回复某张卡时靠它认出回复的是什么；盘面快照靠它找回置顶的盘面卡）。
 * 同一条消息再登记：种类和来历覆盖，发出时刻、所在会话保留第一次的。来历里的编号只是记录，不设外键：
 * 登记写不进，回复这张卡时后端就认不出它，比多一条指向不明的记录更糟。
 */
export const feishuCards = pgTable(
  'feishu_cards',
  {
    messageId: text('message_id').primaryKey(),
    chatId: text('chat_id').notNull(),
    kind: text('kind').$type<FeishuCardKind>().notNull(),
    taskId: text('task_id'),
    askId: text('ask_id'),
    draftId: text('draft_id'),
    notificationId: text('notification_id'),
    outboxId: text('outbox_id'),
    sentAt: timestamp('sent_at', tz).notNull(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check('feishu_cards_kind_known', sql`${t.kind} in (${inList(FEISHU_CARD_KINDS)})`),
    index('feishu_cards_draft_idx').on(t.draftId, t.sentAt),
    index('feishu_cards_outbox_idx').on(t.outboxId, t.sentAt),
    index('feishu_cards_kind_idx').on(t.kind, t.sentAt),
  ],
);
