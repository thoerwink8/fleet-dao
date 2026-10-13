// 驾驶舱「提需求」（#2049，母单 #2047；方案 specs/2047-提需求/方案.md 第二节）：需求、消息、每人对需求的置顶和读到哪。
// 接口约定在 @fleet-dao/shared 的 web-api/requests.ts，能不能做的判法在 request-rules.ts。
// 改这里之前必须知道：
// - 不复用 intents（旧表只读保留）。
// - 删除是软删（deleted_at）；删了满 30 天由引擎的定时任务（request-sweep）连消息一起硬删，并写操作记录。消息、个人状态跟着级联删。
// - 原话逐条存：request_messages 的人话不改、不删（结案后锁死由接口判）。
// - 取值表不用 pg 枚举，用文字加检查约束（和 intents 一个做法）；值表和约定里的枚举逐一对齐（valuesOf）。
import type {
  RequestAnswerState,
  RequestChannel,
  RequestDraft,
  RequestDraftField,
  RequestIssueRef,
  RequestMessageKind,
  RequestStatus,
} from '@fleet-dao/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { valuesOf } from './enums.ts';
import { users } from './ops.ts';
import { repos } from './work.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const REQUEST_STATUS_VALUES = valuesOf<RequestStatus>()([
  'discussing',
  'pending_decision',
  'closed_do',
  'closed_drop',
]);
export const REQUEST_MESSAGE_KIND_VALUES = valuesOf<RequestMessageKind>()([
  'human',
  'commander',
  'system',
  'engine_ask',
  'review',
]);
export const REQUEST_CHANNEL_VALUES = valuesOf<RequestChannel>()(['web', 'mobile']);
export const REQUEST_ANSWER_STATE_VALUES = valuesOf<RequestAnswerState>()(['pending', 'written', 'failed']);

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '));

/** 一条需求一行。 */
export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 给人看的号（「需求 42」）。 */
    seq: integer('seq').notNull().unique().generatedAlwaysAsIdentity(),
    /** 选的项目：只能是 repos 里已导入的。 */
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id),
    /** 发起人：取登录会话。 */
    initiatorId: uuid('initiator_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<RequestStatus>().notNull().default('discussing'),
    /** 拍板人：提交拍板时按 users.decides_requests 定；发起人自己能拍的，确定时就是他自己。 */
    deciderId: uuid('decider_id').references(() => users.id),
    draftJson: jsonb('draft_json').$type<RequestDraft>().notNull(),
    /** 草稿每改一次加 1；提交拍板、确定、拍板都带上看到的版本，只认这一版（开单的幂等键是「需求号 + 版本号」）。 */
    draftVersion: integer('draft_version').notNull().default(1),
    /** 人改过的栏：指挥官不能直接改，只能出「建议改」。 */
    humanEditedFields: jsonb('human_edited_fields').$type<RequestDraftField[]>().notNull().default([]),
    /** 开出的单，可以多张；state 由 B 片从 GitHub 接（上线或关掉满 3 天自动归档）。 */
    issueRefs: jsonb('issue_refs').$type<RequestIssueRef[]>().notNull().default([]),
    /** 「接着这条提」时指向原来那条；原来那条被硬删时置空。 */
    continuesRequestId: uuid('continues_request_id').references((): AnyPgColumn => requests.id, {
      onDelete: 'set null',
    }),
    /** 第一次提交拍板的时刻：提交过的（哪怕被「再聊聊」退回）不能删。 */
    firstSubmittedAt: timestamp('first_submitted_at', tz),
    /** 结案的时刻和放下、不做的理由。 */
    closedAt: timestamp('closed_at', tz),
    closeReason: text('close_reason'),
    archivedAt: timestamp('archived_at', tz),
    deletedAt: timestamp('deleted_at', tz),
    /** 最后一次有动静：人说话、改草稿、状态变了。 */
    lastActivityAt: timestamp('last_activity_at', tz).notNull(),
    /** 这条需求选的模型（C 片用）；没选是空，用「提需求」用途配的。 */
    modelChoice: text('model_choice'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check('requests_status_known', sql`${t.status} in (${inList(REQUEST_STATUS_VALUES)})`),
    check('requests_draft_version_positive', sql`${t.draftVersion} >= 1`),
    check('requests_draft_object', sql`jsonb_typeof(${t.draftJson}) = 'object'`),
    check('requests_human_edited_array', sql`jsonb_typeof(${t.humanEditedFields}) = 'array'`),
    check('requests_issue_refs_array', sql`jsonb_typeof(${t.issueRefs}) = 'array'`),
    // 结案的一定有结案时刻；没结案的没有
    check(
      'requests_closed_shape',
      sql`(${t.status} in ('closed_do', 'closed_drop')) = (${t.closedAt} is not null)`,
    ),
    // 放下、不做一定写了理由
    check('requests_drop_has_reason', sql`${t.status} <> 'closed_drop' or ${t.closeReason} is not null`),
    // 待拍板、已结案·做一定有拍板人
    check(
      'requests_decider_when_decided',
      sql`${t.status} not in ('pending_decision', 'closed_do') or ${t.deciderId} is not null`,
    ),
    // 只有已结案的能归档
    check(
      'requests_archive_only_closed',
      sql`${t.archivedAt} is null or ${t.status} in ('closed_do', 'closed_drop')`,
    ),
    check(
      'requests_close_reason_length',
      sql`${t.closeReason} is null or char_length(${t.closeReason}) between 1 and 500`,
    ),
    index('requests_repo_idx').on(t.repoId),
    index('requests_initiator_idx').on(t.initiatorId),
    index('requests_activity_idx').on(t.lastActivityAt),
    index('requests_deleted_idx').on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
  ],
);

/**
 * 一条消息一行。id 是自增序号：按它排先后，也按它记「读到哪一条」。
 * 人的话（kind=human）一定有说话人（取登录会话）和渠道；别的种类没有说话人。
 */
export const requestMessages = pgTable(
  'request_messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<RequestMessageKind>().notNull(),
    authorId: uuid('author_id').references(() => users.id),
    channel: text('channel').$type<RequestChannel>(),
    /** 原样存，不截断、不改字。 */
    body: text('body').notNull(),
    /** @ 了谁（用户编号）。 */
    mentions: jsonb('mentions').$type<string[]>().notNull().default([]),
    /** 指挥官这一条对草稿的改动（C 片）。 */
    draftPatch: jsonb('draft_patch').$type<Record<string, unknown>>(),
    /** 引擎提问绑定的 GitHub 评论（B 片）。 */
    githubCommentRef: text('github_comment_ref'),
    answerState: text('answer_state').$type<RequestAnswerState>(),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [
    check('request_messages_kind_known', sql`${t.kind} in (${inList(REQUEST_MESSAGE_KIND_VALUES)})`),
    check(
      'request_messages_channel_known',
      sql`${t.channel} is null or ${t.channel} in (${inList(REQUEST_CHANNEL_VALUES)})`,
    ),
    check(
      'request_messages_answer_state_known',
      sql`${t.answerState} is null or ${t.answerState} in (${inList(REQUEST_ANSWER_STATE_VALUES)})`,
    ),
    // 人的话一定有说话人和渠道；不是人的话没有说话人
    check(
      'request_messages_human_shape',
      sql`(${t.kind} = 'human') = (${t.authorId} is not null) and (${t.kind} <> 'human' or ${t.channel} is not null)`,
    ),
    check('request_messages_body_length', sql`char_length(${t.body}) between 1 and 20000`),
    check('request_messages_mentions_array', sql`jsonb_typeof(${t.mentions}) = 'array'`),
    index('request_messages_request_idx').on(t.requestId, t.id),
  ],
);

/** 人对需求的个人状态：置顶（每人各自）、最后读到哪一条（算未读）。 */
export const requestUserState = pgTable(
  'request_user_state',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    pinnedAt: timestamp('pinned_at', tz),
    lastReadMessageId: bigint('last_read_message_id', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.userId] })],
);
