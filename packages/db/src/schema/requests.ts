// 驾驶舱「提需求」（#2049，母单 #2047；方案 specs/2047-提需求/方案.md 第二节）：需求、消息、每人对需求的置顶和读到哪。
// 接口约定在 @fleet-dao/shared 的 web-api/requests.ts，能不能做的判法在 request-rules.ts。
// 改这里之前必须知道：
// - 删除是软删（deleted_at）；删了满 30 天由引擎的定时任务（request-sweep）连消息一起硬删，并写操作记录。消息、个人状态跟着级联删。
// - 原话逐条存：request_messages 的人话不改、不删（结案后锁死由接口判）。
// - 取值表不用 pg 枚举，用文字加检查约束（删改检查约束比删枚举值容易）；值表和约定里的枚举逐一对齐（valuesOf）。
// - 指挥官会话（C 片，#2061）一条需求一行 request_chats，跟着需求级联删；消息上的结构化卡片在 request_messages.card。
import type {
  RequestAnswerState,
  RequestCard,
  RequestChannel,
  RequestChatJob,
  RequestChatPhase,
  RequestChatState,
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
  uniqueIndex,
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
  'idle_closed',
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
    /** 结案（或收口）的时刻和放下、不做的理由、收口的原因。 */
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
    // 结案、收口的一定有那一刻；别的没有
    check(
      'requests_closed_shape',
      sql`(${t.status} in ('closed_do', 'closed_drop', 'idle_closed')) = (${t.closedAt} is not null)`,
    ),
    // 放下、不做、收口一定写了理由
    check(
      'requests_drop_has_reason',
      sql`${t.status} not in ('closed_drop', 'idle_closed') or ${t.closeReason} is not null`,
    ),
    // 待拍板、已结案·做一定有拍板人
    check(
      'requests_decider_when_decided',
      sql`${t.status} not in ('pending_decision', 'closed_do') or ${t.deciderId} is not null`,
    ),
    // 只有已结案、收口的能归档
    check(
      'requests_archive_only_closed',
      sql`${t.archivedAt} is null or ${t.status} in ('closed_do', 'closed_drop', 'idle_closed')`,
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
    /** 引擎提问绑定的那条 GitHub 评论的网址（B 片，只有 engine_ask 有）：评论号在网址末尾的 #issuecomment-<号>。 */
    githubCommentRef: text('github_comment_ref'),
    /** 引擎提问的答复：待答、已写回、写回失败（只有 engine_ask 有）。 */
    answerState: text('answer_state').$type<RequestAnswerState>(),
    /** 答了什么、谁答的、几点答的；写回失败时 answer_error 写原因，答复文字留着，页面点重试不用重打。 */
    answerText: text('answer_text'),
    answerError: text('answer_error'),
    answeredBy: uuid('answered_by').references(() => users.id),
    answeredAt: timestamp('answered_at', tz),
    /** 结构化卡片（C 片，#2061）：指挥官的问题和选项、方案卡、建议改、换模型分隔线、暂停原因、别家意见。形状见 shared 的 RequestCardSchema。 */
    card: jsonb('card').$type<RequestCard>(),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [
    check('request_messages_card_object', sql`${t.card} is null or jsonb_typeof(${t.card}) = 'object'`),
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
    // 引擎提问一定绑了评论、有答复状态；别的种类这两样都没有、也没有答复
    check(
      'request_messages_engine_ask_shape',
      sql`(${t.kind} = 'engine_ask') = (${t.githubCommentRef} is not null) and (${t.kind} = 'engine_ask') = (${t.answerState} is not null)`,
    ),
    check(
      'request_messages_answer_only_on_ask',
      sql`${t.kind} = 'engine_ask' or (${t.answerText} is null and ${t.answerError} is null and ${t.answeredBy} is null and ${t.answeredAt} is null)`,
    ),
    // 同一条评论在同一条需求里只生成一条提问消息（进度同步重跑不重复）
    uniqueIndex('request_messages_comment_unique')
      .on(t.requestId, t.githubCommentRef)
      .where(sql`${t.githubCommentRef} is not null`),
    index('request_messages_request_idx').on(t.requestId, t.id),
  ],
);

export const REQUEST_OPENING_STATE_VALUES = ['opening', 'opened', 'failed'] as const;

/**
 * 开单记录（B 片，#2060）：幂等键是「需求号 + 草稿版本号」（主键就是它），同一版重复请求只开一张单。
 * 页面超时后按这一键查开没开成。requested_by 写在这里（开单之前先占行、先写它），引擎拉到这张单时按它认提出人，
 * 不看 GitHub 上的作者（单是「引擎」机器人开的）。
 * - opening：占了行、正在调 GitHub；超过几分钟没结果的算断了，可以重新占。
 * - opened：开成了，issue_number、issue_url 有值。
 * - failed：没开成，error 写原因；可以重试（重新占行）。
 */
export const requestIssueOpenings = pgTable(
  'request_issue_openings',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    draftVersion: integer('draft_version').notNull(),
    state: text('state').$type<(typeof REQUEST_OPENING_STATE_VALUES)[number]>().notNull(),
    /** 提出人：点「确定，开单」或「同意做」那一刻，取需求的发起人（服务端从库里读，不收前端）。 */
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    /** 开单的人（点按钮的那位：发起人，或合伙人需求里的拍板人）。 */
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => users.id),
    issueNumber: integer('issue_number'),
    issueUrl: text('issue_url'),
    error: text('error'),
    createdAt: timestamp('created_at', tz).notNull(),
    updatedAt: timestamp('updated_at', tz).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.draftVersion] }),
    check('request_issue_openings_state_known', sql`${t.state} in (${inList(REQUEST_OPENING_STATE_VALUES)})`),
    check('request_issue_openings_version_positive', sql`${t.draftVersion} >= 1`),
    check(
      'request_issue_openings_opened_shape',
      sql`(${t.state} = 'opened') = (${t.issueNumber} is not null and ${t.issueUrl} is not null)`,
    ),
    check(
      'request_issue_openings_failed_has_error',
      sql`${t.state} <> 'failed' or (${t.error} is not null and char_length(${t.error}) > 0)`,
    ),
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

export const REQUEST_CHAT_STATE_VALUES = valuesOf<RequestChatState>()(['idle', 'queued', 'running']);
export const REQUEST_CHAT_JOB_VALUES = valuesOf<RequestChatJob>()(['reply', 'review']);
export const REQUEST_CHAT_PHASE_VALUES = valuesOf<RequestChatPhase>()([
  'thinking',
  'reading_code',
  'writing',
]);

/**
 * 一条需求的指挥官会话（C 片，#2061；方案第五节）：后端排一轮（queued），引擎接手（running）、回完回到 idle。
 * 会话活着 = workdir 不空（主线的只读检出还在、session_id 能 --resume）；闲置 30 分钟引擎收掉会话、删检出，清空这几列，
 * 下次有人说话按存下来的消息和草稿重起。换模型也清掉会话（按存档重起）。
 * stream_text / phase 是这一轮写到哪了：引擎边跑边写，后端的 SSE 照它推给页面。
 */
export const requestChats = pgTable(
  'request_chats',
  {
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => requests.id, { onDelete: 'cascade' }),
    state: text('state').$type<RequestChatState>().notNull().default('idle'),
    /** 排的是哪种活；idle 时空。 */
    job: text('job').$type<RequestChatJob>(),
    /** 谁叫的这一轮（说话的人、点按钮的人）。 */
    queuedBy: uuid('queued_by').references(() => users.id),
    queuedAt: timestamp('queued_at', tz),
    startedAt: timestamp('started_at', tz),
    /** 有人点了「停下」：排着的直接撤，跑着的引擎看到就停。 */
    stopRequestedAt: timestamp('stop_requested_at', tz),
    /** 回了几轮（每条最多 40 轮，可调）。 */
    turns: integer('turns').notNull().default(0),
    /** 活着的会话：执行体的会话号、路由、模型、检出目录。 */
    sessionId: text('session_id'),
    routeId: text('route_id'),
    modelId: text('model_id'),
    workdir: text('workdir'),
    /** 会话已经看过的最后一条消息：续会话只喂这之后的。 */
    lastMessageId: bigint('last_message_id', { mode: 'number' }),
    lastTurnAt: timestamp('last_turn_at', tz),
    phase: text('phase').$type<RequestChatPhase>(),
    streamText: text('stream_text').notNull().default(''),
    /** 上一次没接上的原因（「指挥官暂停了：……」）；接上了就清掉。 */
    pausedWhy: text('paused_why'),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check('request_chats_state_known', sql`${t.state} in (${inList(REQUEST_CHAT_STATE_VALUES)})`),
    check(
      'request_chats_job_known',
      sql`${t.job} is null or ${t.job} in (${inList(REQUEST_CHAT_JOB_VALUES)})`,
    ),
    check(
      'request_chats_phase_known',
      sql`${t.phase} is null or ${t.phase} in (${inList(REQUEST_CHAT_PHASE_VALUES)})`,
    ),
    // 闲着就没有活；排着、跑着一定有活
    check('request_chats_job_shape', sql`(${t.state} = 'idle') = (${t.job} is null)`),
    check('request_chats_turns_nonneg', sql`${t.turns} >= 0`),
    index('request_chats_state_idx').on(t.state),
  ],
);
