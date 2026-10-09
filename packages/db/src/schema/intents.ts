// 飞书群聊理成的「意图」（#553 第 4 条，specs/553-对题/方案.md 末节「2026-10-04 拍板」）：意图三张表，外加拒收、进群、
// 用量三张（#795，方案 5.4、5.6）。接口约定在 @fleet-dao/shared 的 intent-api.ts。
// 改这里之前必须知道：
// - 原话原样：intent_messages.text 不截断、不改字；改过的旧版本进 edits，不覆盖；撤回只标 recalled_at，行不删。
// - AI 归纳只由指挥官在开单时写回（summary_*），永远不进原话；没有法国的归纳会话，所以没有归纳的状态、重试那几列。
// - 旧的四张飞书表连历史一起删了（创始人 10-04 拍，迁移 0037）。
// - 取值表不用 pg 枚举，用文字加检查约束（卡片种类以后还会加，删改检查约束比删枚举值容易）；值表和约定里的枚举逐一对齐（valuesOf）。
import type { IntentChatKindSchema, IntentMessageSourceSchema, IntentStatusSchema } from '@fleet-dao/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { valuesOf } from './enums.ts';
import { users } from './ops.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export type IntentStatus = z.infer<typeof IntentStatusSchema>;
export type IntentChatKind = z.infer<typeof IntentChatKindSchema>;
export type IntentMessageSource = z.infer<typeof IntentMessageSourceSchema>;

export const INTENT_STATUSES = valuesOf<IntentStatus>()(['new', 'linked', 'dropped']);
export const INTENT_CHAT_KINDS = valuesOf<IntentChatKind>()(['p2p', 'group']);
export const INTENT_MESSAGE_SOURCES = valuesOf<IntentMessageSource>()(['event', 'backfill']);

/** 开成的一张单：owner/仓#号、谁挂的、几点（ISO）。 */
export interface IntentLinkRow {
  issue: string;
  by: string;
  at: string;
}

/** 原话被改掉的一版：原文、飞书原始内容和它的摘要、被改掉的时刻（ISO）。 */
export interface IntentEditRow {
  text: string;
  rawContent: string;
  contentHash: string;
  replacedAt: string;
}

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '));

/**
 * 一段意图一行。切段（这句归到哪段）的判法只有一份（packages/api 的 intents.ts），两个存储都照它。
 * revision：来一条、撤回一条、改一条、写回归纳、开成单、放下都加 1。card_rev：卡上看得出的变化（不含改字）才加 1，
 * card_shown_rev 是飞书上那张卡显示到第几版；card_due_at 到了且卡不是最新的，长轮询就把它交给网关。
 */
export const intents = pgTable(
  'intents',
  {
    id: uuid('id').primaryKey(),
    /** 给人看的号（「意图 42」）。 */
    seq: integer('seq').notNull().unique().generatedAlwaysAsIdentity(),
    chatId: text('chat_id').notNull(),
    chatKind: text('chat_kind').$type<IntentChatKind>().notNull(),
    /** 飞书话题；不在话题里就空。 */
    threadId: text('thread_id'),
    status: text('status').$type<IntentStatus>().notNull().default('new'),
    /** 接着哪一段说的：要接的那段已经开成单或放下了，就另起这一段、记下它。 */
    continuesIntentId: uuid('continues_intent_id').references((): AnyPgColumn => intents.id),
    revision: integer('revision').notNull().default(1),
    /** 这段按发出时刻最早的一条：卡回复在它下面。 */
    firstMessageId: text('first_message_id').notNull(),
    firstMessageAt: timestamp('first_message_at', tz).notNull(),
    lastMessageAt: timestamp('last_message_at', tz).notNull(),
    /** 指挥官开单时写回的 AI 归纳：正文、谁写的、几点、写的时候这段有几条原话（含撤回的）。 */
    summaryText: text('summary_text'),
    summaryBy: text('summary_by'),
    summaryAt: timestamp('summary_at', tz),
    summaryCovers: integer('summary_covers'),
    /** 开成（并进）的单，可多张。 */
    links: jsonb('links').$type<IntentLinkRow[]>().notNull().default([]),
    dropReason: text('drop_reason'),
    droppedBy: text('dropped_by'),
    droppedAt: timestamp('dropped_at', tz),
    cardRev: integer('card_rev').notNull().default(1),
    cardShownRev: integer('card_shown_rev'),
    cardMessageId: text('card_message_id'),
    cardDueAt: timestamp('card_due_at', tz),
    /** 卡连着没发成的次数（发成了清零）和最近一次的原因。 */
    cardAttempts: integer('card_attempts').notNull().default(0),
    cardError: text('card_error'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check('intents_status_known', sql`${t.status} in (${inList(INTENT_STATUSES)})`),
    check('intents_chat_kind_known', sql`${t.chatKind} in (${inList(INTENT_CHAT_KINDS)})`),
    check('intents_revision_positive', sql`${t.revision} >= 1`),
    check('intents_message_order', sql`${t.firstMessageAt} <= ${t.lastMessageAt}`),
    // 归纳四样要么都有、要么都没有
    check(
      'intents_summary_shape',
      sql`(${t.summaryText} is null) = (${t.summaryBy} is null) and (${t.summaryText} is null) = (${t.summaryAt} is null) and (${t.summaryText} is null) = (${t.summaryCovers} is null)`,
    ),
    check(
      'intents_summary_length',
      sql`${t.summaryText} is null or char_length(${t.summaryText}) between 1 and 2000`,
    ),
    check('intents_summary_covers_nonneg', sql`${t.summaryCovers} is null or ${t.summaryCovers} >= 0`),
    check('intents_links_array', sql`jsonb_typeof(${t.links}) = 'array'`),
    // 开成了单就一定挂着单，挂着单就是开成了
    check('intents_linked_has_links', sql`(${t.status} = 'linked') = (jsonb_array_length(${t.links}) > 0)`),
    // 放下的三样要么都有、要么都没有；放下了就必有理由（放下后又开成单的，理由留着当历史）
    check(
      'intents_drop_shape',
      sql`(${t.dropReason} is null) = (${t.droppedBy} is null) and (${t.dropReason} is null) = (${t.droppedAt} is null) and (${t.status} <> 'dropped' or ${t.dropReason} is not null)`,
    ),
    check('intents_card_rev_positive', sql`${t.cardRev} >= 1`),
    check(
      'intents_card_shown_rev_range',
      sql`${t.cardShownRev} is null or ${t.cardShownRev} between 1 and ${t.cardRev}`,
    ),
    check('intents_card_attempts_nonneg', sql`${t.cardAttempts} >= 0`),
    index('intents_chat_thread_idx').on(t.chatId, t.threadId),
    index('intents_status_seq_idx').on(t.status, t.seq),
    index('intents_card_due_idx').on(t.cardDueAt).where(sql`${t.cardDueAt} is not null`),
    // 一张卡只属于一段：回复这张卡的话靠它找回是哪段
    uniqueIndex('intents_card_message_unique').on(t.cardMessageId).where(sql`${t.cardMessageId} is not null`),
  ],
);

/**
 * 一条飞书消息一行，原话就在这。消息编号是主键（幂等）。content_hash 是飞书原始内容的摘要：同一个编号内容变了、
 * 又没带「改过」，是网关出了错，拒收。
 */
export const intentMessages = pgTable(
  'intent_messages',
  {
    messageId: text('message_id').primaryKey(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intents.id),
    chatId: text('chat_id').notNull(),
    threadId: text('thread_id'),
    parentId: text('parent_id'),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id),
    /** 收到时说话人的显示名（快照）。 */
    senderName: text('sender_name').notNull(),
    sentAt: timestamp('sent_at', tz).notNull(),
    receivedAt: timestamp('received_at', tz).notNull(),
    source: text('source').$type<IntentMessageSource>().notNull(),
    msgType: text('msg_type').notNull(),
    /** 规范化后的原文（最新一版），不截断。 */
    text: text('text').notNull(),
    rawContent: text('raw_content').notNull(),
    contentHash: text('content_hash').notNull(),
    atBot: boolean('at_bot').notNull(),
    /** 合并转发展开出来的：那条合并转发的编号、原说话人（飞书给不了就空）。 */
    forwardOf: text('forward_of'),
    forwardSender: text('forward_sender'),
    /**
     * 最新一版是几点改成的（没改过就空）；之前的每一版在 edits（旧的在前）。第一次收到的就是改过的（原来那版没收到）时
     * 只有 edited_at、edits 是空的：显示「飞书里改过，旧的那版这里没有」。
     */
    editedAt: timestamp('edited_at', tz),
    edits: jsonb('edits').$type<IntentEditRow[]>().notNull().default([]),
    recalledAt: timestamp('recalled_at', tz),
  },
  (t) => [
    check('intent_messages_source_known', sql`${t.source} in (${inList(INTENT_MESSAGE_SOURCES)})`),
    check('intent_messages_msg_type_length', sql`char_length(${t.msgType}) between 1 and 50`),
    check('intent_messages_forward_shape', sql`${t.forwardSender} is null or ${t.forwardOf} is not null`),
    check('intent_messages_edits_array', sql`jsonb_typeof(${t.edits}) = 'array'`),
    check(
      'intent_messages_edited_shape',
      sql`jsonb_array_length(${t.edits}) = 0 or ${t.editedAt} is not null`,
    ),
    index('intent_messages_intent_idx').on(t.intentId, t.sentAt),
    index('intent_messages_chat_idx').on(t.chatId, t.sentAt),
  ],
);

/**
 * 白名单群里不是创始人说的：只有群、open_id 末 4 位、时刻、原因。没有原文、没有长度（#795，方案 5.6）。
 * 一次一句一条，不去重：证据要留着；驾驶舱提醒另按「群 + 尾号」收成一条。
 */
export const feishuRejections = pgTable(
  'feishu_rejections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    openIdTail: text('open_id_tail').notNull(),
    at: timestamp('at', tz).notNull(),
    reason: text('reason').notNull(),
    receivedAt: timestamp('received_at', tz).notNull(),
  },
  (t) => [
    check('feishu_rejections_tail_len', sql`char_length(${t.openIdTail}) = 4`),
    check('feishu_rejections_reason_len', sql`char_length(${t.reason}) between 1 and 200`),
  ],
);

/** 白名单外的人进了白名单群：一次进群事件里每个外人一行，字段和拒收一样，没有名字。 */
export const feishuJoins = pgTable(
  'feishu_joins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    openIdTail: text('open_id_tail').notNull(),
    at: timestamp('at', tz).notNull(),
    reason: text('reason').notNull(),
    receivedAt: timestamp('received_at', tz).notNull(),
  },
  (t) => [
    check('feishu_joins_tail_len', sql`char_length(${t.openIdTail}) = 4`),
    check('feishu_joins_reason_len', sql`char_length(${t.reason}) between 1 and 200`),
  ],
);

/** 网关这个北京月调飞书成功了多少次。没有这一行就是 0（读到了，不是读不到）。 */
export const feishuUsageMonths = pgTable(
  'feishu_usage_months',
  {
    month: text('month').primaryKey(),
    calls: integer('calls').notNull(),
  },
  (t) => [
    check('feishu_usage_months_shape', sql`${t.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check('feishu_usage_months_calls', sql`${t.calls} >= 0`),
  ],
);

/** 撤回事件一行。原消息还没到时它就是墓碑：原消息后到，直接按撤回存。 */
export const intentRecalls = pgTable(
  'intent_recalls',
  {
    messageId: text('message_id').primaryKey(),
    chatId: text('chat_id').notNull(),
    recalledAt: timestamp('recalled_at', tz).notNull(),
    receivedAt: timestamp('received_at', tz).notNull(),
    source: text('source').$type<IntentMessageSource>().notNull(),
  },
  (t) => [check('intent_recalls_source_known', sql`${t.source} in (${inList(INTENT_MESSAGE_SOURCES)})`)],
);
