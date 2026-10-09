// 飞书只做一件事：把群聊理成一段段「意图」（#553 第 4 条，specs/553-对题/方案.md 末节「2026-10-04 拍板」）。两份约定：
// 1. 网关（packages/feishu，香港）⇄ 后端（packages/api，法国）的八条接口 IntentRoutes：收原话、收撤回、补漏游标、
//    取要发的意图卡、卡的回执，外加拒收记录、进群记录、飞书接口用量（#795，方案 5.4、5.6）。走法和 feishu-api.ts 一样：经隧道调 /api，带网关通行证；acting=required 的带
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

/**
 * 飞书免费版每月调用上限。加表情、发卡、改卡、翻历史都算，事件不算。
 * 已经打出去的失败和超时也算：飞书那边可能已经计了，只算成功会把累计算少，八成报警来得晚。
 */
export const FEISHU_MONTHLY_CALL_LIMIT = 10_000;
/** 用到这个比例（含正好到）就报警，并按方案 5.4 的顺序降级。 */
export const FEISHU_USAGE_WARN_RATIO = 0.8;
/** 白名单群里不是创始人说话：网关丢掉之后留给后端的原因。记录里没有原文。 */
export const FEISHU_REJECTION_REASON = '白名单群里不是创始人在说话';
/** 白名单外的人进了白名单群。 */
export const FEISHU_JOIN_REASON = '白名单外的人进了群';
/** 机器人在群里说的那一句（方案 5.6）。 */
export const FEISHU_JOIN_GROUP_TEXT = '这个群的消息机器人都读得到，只存两位创始人的话';
/** 驾驶舱提醒标题：有人在白名单群里说话，但没存。 */
export const FEISHU_OUTSIDER_SPOKE_TITLE = '团队群里出现了白名单外的人：机器人读得到他的话，没存';
/** 驾驶舱提醒标题：有白名单外的人进了群。 */
export const FEISHU_OUTSIDER_JOINED_TITLE =
  '团队群里进来了白名单外的人：机器人已在群里说明只存两位创始人的话';
/** 驾驶舱提醒标题：这个月的飞书调用到了八成。 */
export const FEISHU_USAGE_ALERT_TITLE = '飞书接口用量到了八成';

const BEIJING_OFFSET_MS = 8 * 3_600_000;

/** 北京时间的自然月，例如 2026-09。飞书额度按这个月累计（无夏令时，固定 UTC+8）。 */
export function beijingMonth(ms: number): string {
  const shifted = new Date(ms + BEIJING_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) throw new RangeError('Invalid time value');
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** ok 没到八成；over 到了八成，三档降级一起上；unreadable 读不到用量（或上限不是正数），只停「收到」表情。 */
export function feishuUsageLevel(s: {
  calls: number;
  limit: number;
  readable: boolean;
}): 'ok' | 'over' | 'unreadable' {
  if (!s.readable || !(s.limit > 0)) return 'unreadable';
  if (s.calls / s.limit >= FEISHU_USAGE_WARN_RATIO) return 'over';
  return 'ok';
}

/** 这一档要停掉的飞书动作。顺序是方案 5.4 的优先级；到了八成三档一起停，读不到只停表情。 */
export type FeishuUsageStop = 'ack' | 'card-update' | 'backfill';

export function feishuUsageStops(level: 'ok' | 'over' | 'unreadable'): FeishuUsageStop[] {
  if (level === 'over') return ['ack', 'card-update', 'backfill'];
  if (level === 'unreadable') return ['ack'];
  return [];
}

/** 写在意图卡上、也写进网关 status 的那一句。ok 只报数字，不说降级。 */
export function feishuUsageSentence(
  level: 'ok' | 'over' | 'unreadable',
  s: { calls: number; limit: number },
): string {
  if (level === 'unreadable') return '飞书接口用量读不到，按可能超了处理：只停「收到」表情';
  const pct = s.limit > 0 ? Math.floor((s.calls / s.limit) * 100) : 0;
  const used = `飞书接口这个月用了 ${s.calls}/${s.limit}（${pct}%）`;
  if (level === 'over') {
    return `${used}，已按顺序降级：停「收到」表情、停改卡（只发第一张）、补漏只在后端恢复时翻一次`;
  }
  return used;
}

/** 用量到了八成或读不到时，在卡的末行写明。已经写过的不重复；满 10 行就换掉最后一行，保证这句看得见。 */
export function withFeishuUsageLine(
  lines: readonly string[],
  usage: { calls: number; limit: number; readable: boolean },
): string[] {
  const level = feishuUsageLevel(usage);
  if (level === 'ok') return [...lines];
  const sentence = feishuUsageSentence(level, usage);
  if (lines.some((line) => line.includes('飞书接口'))) return [...lines];
  if (lines.length >= 10) return [...lines.slice(0, 9), sentence];
  return [...lines, sentence];
}

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

/** 这个月网关调飞书多少次。readable=false 是没读出来（不能把 calls 当成真的 0）。 */
export const FeishuUsageSnapshot = z.strictObject({
  /** 北京时间的自然月。 */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  calls: z.number().int().min(0),
  limit: z.number().int().positive(),
  readable: z.boolean(),
});

export const IntentCardsResponse = z.object({
  items: z.array(IntentCardSchema).max(100),
  asOf: Time,
  /** 长轮询顺便把这个月的用量带给网关，不用另等心跳。 */
  usage: FeishuUsageSnapshot,
});

const OpenIdTail = z.string().length(4);
const OutsiderReason = z.string().min(1).max(200);

/**
 * POST /feishu/intake/rejections（acting=none）。白名单群里不是创始人说的：只有群、open_id 末 4 位、时刻、原因。
 * 多一个字段（原文、长度）就 400，不存。
 */
export const FeishuRejectionRequest = z.strictObject({
  chatId: FeishuId,
  openIdTail: OpenIdTail,
  at: Time,
  reason: OutsiderReason,
});
export const FeishuRejectionResponse = z.strictObject({ recorded: z.literal(true) });

/** POST /feishu/intake/joins（acting=none）。一次进群事件里每个白名单外的人一条，末 4 位放在 openIdTails。 */
export const FeishuJoinRequest = z.strictObject({
  chatId: FeishuId,
  openIdTails: z.array(OpenIdTail).min(1).max(50),
  at: Time,
  reason: OutsiderReason,
});
export const FeishuJoinResponse = z.strictObject({ recorded: z.number().int().positive() });

/**
 * POST /feishu/gateway/usage（acting=none）。
 * calls 是这一批新打出去的次数（含失败、超时、重试）。reportId 由网关生成，同一批重报必须带同一个；
 * 后端按它去重后再按 at 所在的北京月累加——回应丢了再送也不会加第二次。
 */
export const FeishuUsageReportRequest = z.strictObject({
  reportId: z.uuid(),
  calls: z.number().int().min(0).max(1_000_000),
  at: Time,
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
  intakeRejection: {
    method: 'POST',
    path: '/feishu/intake/rejections',
    acting: 'none',
    request: FeishuRejectionRequest,
    response: FeishuRejectionResponse,
  },
  intakeJoin: {
    method: 'POST',
    path: '/feishu/intake/joins',
    acting: 'none',
    request: FeishuJoinRequest,
    response: FeishuJoinResponse,
  },
  usage: {
    method: 'POST',
    path: '/feishu/gateway/usage',
    acting: 'none',
    request: FeishuUsageReportRequest,
    response: FeishuUsageSnapshot,
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

export const IntentCliListOutput = z.object({
  ok: z.literal(true),
  intents: z.array(IntentDetailSchema),
  /** 还有没列出来的（超过 --limit）：调用方要加大 --limit 再读，不能当成全部。 */
  more: z.boolean(),
});
export const IntentCliShowOutput = z.object({ ok: z.literal(true), intent: IntentDetailSchema });
export const IntentCliWriteOutput = z.object({
  ok: z.literal(true),
  /** linked 第一次开成单；added 又挂了一张（--relink）；updated 同一张单再写一次，只更新归纳；dropped 放下了；already 本来就是这样。 */
  result: z.enum(['linked', 'added', 'updated', 'dropped', 'already']),
  intent: IntentDetailSchema,
});
