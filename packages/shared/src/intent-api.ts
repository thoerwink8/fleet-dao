// 飞书只做一件事：把群聊理成一段段「意图」（#553 第 4 条，specs/553-对题/方案.md 末节「2026-10-04 拍板」）。两份约定：
// 1. 网关（packages/feishu，香港）⇄ 后端（packages/api，法国）的五条接口 IntentRoutes：收原话、收撤回、补漏游标、
//    取要发的意图卡、卡的回执。走法和 feishu-api.ts 一样：经隧道调 /api，带网关通行证；acting=required 的带
//    X-Fleet-Acting-Feishu（说这句话的那位创始人），后端按 open_id 认人。
// 2. 指挥官读写意图的样子：法国上 `fleet-api intent … --json` 打的就是 IntentCli* 这几种，本机 `pnpm intents` 按它解析。
//    指挥官不经 HTTP 读写（方案 5.2：不新发长期令牌、不碰 session.ts、不多开口子），走已有的 ssh。
// 改这里之前必须知道：
// - 原话原样：text 是网关规范化后的原文（@ 换成名字、富文本取文字），后端不截、不改字；超过上限整条拒收（400），不截断。
// - AI 归纳只在开单那一刻由指挥官写（intent link），永远不进「原话」；卡上的字由后端拼好、网关照着发，卡上没有按钮。
// - 两边都按这份解析，字段增删两边一起改。
import { z } from 'zod';
import type { FeishuRoute } from './feishu-api.ts';

const Id = z.string().min(1).max(200);
const Time = z.iso.datetime({ offset: true });
/** 飞书的消息、会话、话题编号（om_… / oc_… / omt_…）。 */
const FeishuId = z.string().min(1).max(100);

/** 一条原话最长多少字（UTF-16 计）：飞书一条文本消息的请求体上限是 150 KB，到不了；超了整条拒收，不截。 */
export const INTENT_TEXT_MAX = 150_000;
/** 飞书给的原始 content（JSON 字符串）最长多少。 */
export const INTENT_RAW_MAX = 300_000;
/** 指挥官写的 AI 归纳最长多少字。 */
export const INTENT_SUMMARY_MAX = 2_000;
/** 放下一段意图时写的理由最长多少字。 */
export const INTENT_REASON_MAX = 500;

export const IntentChatKindSchema = z.enum(['p2p', 'group']);
/** event：飞书推来的事件；backfill：网关补漏时翻飞书历史补送的。 */
export const IntentMessageSourceSchema = z.enum(['event', 'backfill']);
/** new 还没用过；linked 开成或并进了单；dropped 放下了（带理由）。 */
export const IntentStatusSchema = z.enum(['new', 'linked', 'dropped']);
/** 单的写法：owner/仓#号。 */
export const IntentIssueRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#[1-9]\d{0,9}$/, '写成 owner/仓#号');

// —— 网关 → 后端：收原话 ——

/**
 * POST /feishu/intake/messages（acting=required：说这句话的那位创始人）。白名单外的人网关在入口就丢，不转。
 * 同一条消息（messageId）再来：内容（rawContent）一样是重放，什么都不改；带 editedAt 的是改过的新一版，另存一版、
 * 原来那版留着；没带 editedAt 却换了内容、换了人、换了会话，是网关出了错，409 message_reused。
 */
export const IntentIntakeMessageRequest = z.object({
  messageId: FeishuId,
  chatId: FeishuId,
  chatKind: IntentChatKindSchema,
  /** 飞书话题（thread_id）：同一个话题算同一段。 */
  threadId: FeishuId.optional(),
  /** 回复的是哪条（飞书的 parent_id；话题里的回复没有就填 root_id）：回复了某段里的话或某张意图卡，就进那段。 */
  parentId: FeishuId.optional(),
  /** 飞书的发出时刻（create_time）。 */
  sentAt: Time,
  /** 改过的消息：飞书的改动时刻（update_time）。 */
  editedAt: Time.optional(),
  source: IntentMessageSourceSchema,
  /** 飞书消息类型（text、post、image、file、audio、merge_forward……），认不出的也照填。 */
  msgType: z.string().min(1).max(50),
  /** 规范化后的原文；非文字消息是网关写的占位（「[图片]」「[文件 名字]」「[认不出的消息类型 xxx]」）。不截断。 */
  text: z.string().max(INTENT_TEXT_MAX),
  /** 飞书给的原始 content，留底对账；也是判「同一条消息内容变没变」的依据。 */
  rawContent: z.string().max(INTENT_RAW_MAX),
  /** 这句 @了机器人：这段马上出卡，不等停下来。 */
  atBot: z.boolean(),
  /** 「@机器人 另起」：@了机器人、去掉那个 @ 后整句就是「另起」。从这句起另起一段，这是飞书上唯一的口令。 */
  newSegment: z.boolean(),
  /** 合并转发展开出来的一条：of 是那条合并转发消息的编号；senderName 是原说话人，飞书给不了就不填（显示「原说话人不知道」）。 */
  forward: z
    .object({
      of: FeishuId,
      senderName: z.string().min(1).max(200).optional(),
    })
    .optional(),
});

export const IntentIntakeMessageResponse = z.object({
  /** stored 新存；replayed 同一条再来，什么都没改；edited 另存了一版；recalled 撤回先到过，这条按撤回存。 */
  status: z.enum(['stored', 'replayed', 'edited', 'recalled']),
  /** 归进了第几段意图。 */
  intentSeq: z.number().int().positive(),
});

/**
 * POST /feishu/intake/recalls（acting=none：飞书的撤回事件不带是谁撤的）。行不删，只标撤回，不再进单子的「原话」栏。
 * 撤回比原消息先到（补漏时会乱序）：先记下这个编号已撤回，原消息到了直接按撤回存。
 */
export const IntentIntakeRecallRequest = z.object({
  messageId: FeishuId,
  chatId: FeishuId,
  recalledAt: Time,
  source: IntentMessageSourceSchema,
});

export const IntentIntakeRecallResponse = z.object({
  /** recalled 标上了；already 早就标过；tombstone 原消息还没到，先记下。 */
  status: z.enum(['recalled', 'already', 'tombstone']),
  /** 那条原话在第几段（tombstone 没有）。 */
  intentSeq: z.number().int().positive().optional(),
});

/**
 * GET /feishu/intake/cursors（acting=none）：补漏前问每个会话存到哪了。带 chatId 只问这一个，没见过的回 known=false
 * （不回 0、不回 1970 年）；不带回全部见过的会话（私聊的会话编号网关自己不存，靠这里拿）。
 */
export const IntentCursorsQuery = z.object({ chatId: FeishuId.optional() });

export const IntentChatCursorSchema = z.discriminatedUnion('known', [
  z.object({
    known: z.literal(true),
    chatId: FeishuId,
    chatKind: IntentChatKindSchema,
    /** 存下的最晚一条的发出时刻和编号：从这里往后翻飞书历史。 */
    lastSentAt: Time,
    lastMessageId: FeishuId,
    messages: z.number().int().positive(),
  }),
  z.object({ known: z.literal(false), chatId: FeishuId }),
]);

export const IntentCursorsResponse = z.object({
  chats: z.array(IntentChatCursorSchema),
  asOf: Time,
});

// —— 后端 → 网关：意图卡 ——

/**
 * GET /feishu/intent-cards?waitSeconds=25（acting=none）：长轮询，有该发或该改的卡就马上回，没有就等到 waitSeconds。
 * 什么时候该发：一段停下来（私聊 90 秒、群 5 分钟没新话），有人 @机器人 就马上；之后又来了新话、撤回了、指挥官写回了
 * 归纳或开成了单，原地改那张卡。库读不了回 503 写明原因，不回空列表。
 */
export const IntentCardsQuery = z.object({
  waitSeconds: z.coerce.number().int().min(0).max(25).default(25),
});

export const IntentCardSchema = z.object({
  intentId: Id,
  seq: z.number().int().positive(),
  /** 卡的第几版：回执原样带回来，后端据此判飞书上那张是不是最新的。 */
  cardRev: z.number().int().positive(),
  chatId: FeishuId,
  /** 第一次发：回复这段的第一条原话。 */
  replyToMessageId: FeishuId,
  /** 已经发过：原地改这张；飞书不让改了（超过 14 天）就新发一张，回执里带新的编号。 */
  cardMessageId: FeishuId.optional(),
  /** 卡上的字（后端拼好，网关照着发，没有按钮）：标题一行，下面每行一段。 */
  title: z.string().min(1).max(300),
  lines: z
    .array(
      z
        .string()
        .min(1)
        .max(INTENT_SUMMARY_MAX + 300),
    )
    .min(1)
    .max(10),
});

export const IntentCardsResponse = z.object({
  items: z.array(IntentCardSchema).max(100),
  asOf: Time,
});

/** 卡的回执：发了、改了只认飞书回的消息编号；没发成带原因，后端过一阵再给。 */
export const IntentCardAckSchema = z.object({
  intentId: Id,
  cardRev: z.number().int().positive(),
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('sent'), messageId: FeishuId }),
    z.object({ status: z.literal('updated'), messageId: FeishuId }),
    z.object({ status: z.literal('failed'), error: z.string().min(1).max(500) }),
  ]),
});

/** POST /feishu/intent-cards/acks（acting=none）：按条处理，认不出的跳过（回 skipped），不让整批被拒。 */
export const IntentCardAckRequest = z.object({ acks: z.array(IntentCardAckSchema).min(1).max(100) });
export const IntentCardAckResponse = z.object({
  applied: z.number().int().min(0),
  skipped: z.number().int().min(0),
});

// —— 路由表（路径都在 WEB_API_PREFIX 之下）。后端按每条的 acting 放行 ——

export const IntentRoutes = {
  intakeMessage: {
    method: 'POST',
    path: '/feishu/intake/messages',
    acting: 'required',
    request: IntentIntakeMessageRequest,
    response: IntentIntakeMessageResponse,
  },
  intakeRecall: {
    method: 'POST',
    path: '/feishu/intake/recalls',
    acting: 'none',
    request: IntentIntakeRecallRequest,
    response: IntentIntakeRecallResponse,
  },
  cursors: {
    method: 'GET',
    path: '/feishu/intake/cursors',
    acting: 'none',
    query: IntentCursorsQuery,
    response: IntentCursorsResponse,
  },
  cards: {
    method: 'GET',
    path: '/feishu/intent-cards',
    acting: 'none',
    query: IntentCardsQuery,
    response: IntentCardsResponse,
  },
  ackCards: {
    method: 'POST',
    path: '/feishu/intent-cards/acks',
    acting: 'none',
    request: IntentCardAckRequest,
    response: IntentCardAckResponse,
  },
} as const satisfies Record<string, FeishuRoute>;

// —— 指挥官读写意图（fleet-api intent … --json） ——

/** 一条原话。ord 是这段里按发出时刻排的第几条（从 1 起，撤回的也占号）。 */
export const IntentMessageSchema = z.object({
  messageId: FeishuId,
  ord: z.number().int().positive(),
  senderUserId: Id,
  /** 收到时说话人的显示名（存的快照）。 */
  senderName: z.string(),
  sentAt: Time,
  receivedAt: Time,
  source: IntentMessageSourceSchema,
  msgType: z.string(),
  /** 最新一版原文，一个字没改。 */
  text: z.string(),
  threadId: FeishuId.optional(),
  parentId: FeishuId.optional(),
  forward: z.object({ of: FeishuId, senderName: z.string().optional() }).optional(),
  /** 最新一版是几点改成的（飞书给的）；有它、edits 却是空的：飞书里改过，旧的那版这里没收到。 */
  editedAt: Time.optional(),
  /** 改过的话，之前的每一版（旧的在前）；replacedAt 是这一版被改掉的时刻（飞书给的改动时刻）。 */
  edits: z.array(z.object({ text: z.string(), replacedAt: Time })),
  /** 在飞书撤回了：不进单子的「原话」栏。 */
  recalledAt: Time.optional(),
  /** 撤回发生在这段开成单之后：单子是公开仓，抄进去的收不回来，要人定删不删。 */
  recalledAfterLink: z.boolean(),
});

export const IntentSummarySchema = z.object({
  text: z.string().min(1).max(INTENT_SUMMARY_MAX),
  /** 谁写的：哪个会话、哪个模型（例如「指挥官会话 · Claude Opus 5.5」）。 */
  by: z.string().min(1).max(200),
  at: Time,
  /** 写的时候这段有几条原话（含撤回的）：之后又来的不在归纳里。 */
  covers: z.number().int().min(0),
});

export const IntentLinkSchema = z.object({
  issue: IntentIssueRefSchema,
  by: z.string(),
  at: Time,
});

export const IntentDetailSchema = z.object({
  id: Id,
  seq: z.number().int().positive(),
  status: IntentStatusSchema,
  chatId: FeishuId,
  chatKind: IntentChatKindSchema,
  threadId: FeishuId.optional(),
  /** 接着哪一段说的（那段已经开成单或放下了，就另起这一段）。 */
  continuesSeq: z.number().int().positive().optional(),
  /** 每来一条、撤回一条、改一条、写回归纳、开成单、放下都加 1。 */
  revision: z.number().int().positive(),
  firstMessageAt: Time,
  lastMessageAt: Time,
  messages: z.array(IntentMessageSchema),
  summary: IntentSummarySchema.optional(),
  links: z.array(IntentLinkSchema),
  dropped: z.object({ reason: z.string(), by: z.string(), at: Time }).optional(),
  card: z.object({
    /** 飞书上那张卡；还没发过就没有。 */
    messageId: FeishuId.optional(),
    /** 卡现在显示到第几版、最新是第几版。 */
    shownRev: z.number().int().positive().optional(),
    rev: z.number().int().positive(),
    /** 下次该发（改）的时刻；没有就是不用发。 */
    dueAt: Time.optional(),
    attempts: z.number().int().min(0),
    error: z.string().optional(),
  }),
});

/** 命令行没做成时打的那一行（--json）：usage 参数不对、not_found 没有这段、refused 不让做（原因在 why）、error 库出错。 */
export const IntentCliFailure = z.object({
  ok: z.literal(false),
  reason: z.enum(['usage', 'not_found', 'refused', 'error']),
  why: z.string(),
});

export const IntentCliListOutput = z.object({ ok: z.literal(true), intents: z.array(IntentDetailSchema) });
export const IntentCliShowOutput = z.object({ ok: z.literal(true), intent: IntentDetailSchema });
export const IntentCliWriteOutput = z.object({
  ok: z.literal(true),
  /** linked 第一次开成单；added 又挂了一张（--relink）；updated 同一张单再写一次，只更新归纳；dropped 放下了；already 本来就是这样。 */
  result: z.enum(['linked', 'added', 'updated', 'dropped', 'already']),
  intent: IntentDetailSchema,
});
