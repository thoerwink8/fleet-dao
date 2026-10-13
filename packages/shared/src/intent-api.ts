// 飞书收缩后（#2047 提需求 F1，方案第八节）只剩登录和手机上的单向通知；群聊、私聊不再生成意图。两份约定：
// 1. 网关（packages/feishu，香港）⇄ 后端（packages/api，法国）的两条接口 IntentRoutes：进群记录、飞书接口用量
//    （#795，方案 5.4、5.6）。走法和 feishu-api.ts 一样：经隧道调 /api，带网关通行证。
// 2. 指挥官读写已有意图的样子：法国上 `fleet-api intent … --json` 打的就是 IntentCli* 这几种，本机 `pnpm intents` 按它解析。
//    指挥官不经 HTTP 读写（方案 5.2：不新发长期令牌、不碰 session.ts、不多开口子），走已有的 ssh。
//    意图表和已有数据只读保留；网关不再往里写新的。
// 改这里之前必须知道：
// - 原话原样：text 是当时网关规范化后的原文，后端不截、不改字；超过上限整条拒收（400），不截断。
// - AI 归纳只在开单那一刻由指挥官写（intent link），永远不进「原话」。
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
 * 飞书免费版每月调用上限。发消息、改卡都算，事件不算。
 * 已经打出去的失败和超时也算：飞书那边可能已经计了，只算成功会把累计算少，八成报警来得晚。
 */
export const FEISHU_MONTHLY_CALL_LIMIT = 10_000;
/** 用到这个比例（含正好到）就报警。 */
export const FEISHU_USAGE_WARN_RATIO = 0.8;
/** 白名单外的人进了白名单群。 */
export const FEISHU_JOIN_REASON = '白名单外的人进了群';
/** 机器人在群里说的那一句（方案 5.6）。 */
export const FEISHU_JOIN_GROUP_TEXT = '这个群里的通知所有人都看得到；机器人不收群里的话，要提需求请到驾驶舱';
/** 驾驶舱提醒标题：有白名单外的人进了群。 */
export const FEISHU_OUTSIDER_JOINED_TITLE = '团队群里进来了白名单外的人：机器人已在群里说明';
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

/** ok 没到八成；over 到了八成，驾驶舱报警；unreadable 读不到用量（或上限不是正数）。 */
export function feishuUsageLevel(s: {
  calls: number;
  limit: number;
  readable: boolean;
}): 'ok' | 'over' | 'unreadable' {
  if (!s.readable || !(s.limit > 0)) return 'unreadable';
  if (s.calls / s.limit >= FEISHU_USAGE_WARN_RATIO) return 'over';
  return 'ok';
}

/** 写进驾驶舱提醒和网关心跳的那一句。 */
export function feishuUsageSentence(
  level: 'ok' | 'over' | 'unreadable',
  s: { calls: number; limit: number },
): string {
  if (level === 'unreadable') return '飞书接口用量读不到，按可能超了处理';
  const pct = s.limit > 0 ? Math.floor((s.calls / s.limit) * 100) : 0;
  const used = `飞书接口这个月用了 ${s.calls}/${s.limit}（${pct}%）`;
  if (level === 'over') return `${used}，快到上限了：手机通知可能发不出去`;
  return used;
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

/** 这个月网关调飞书多少次。readable=false 是没读出来（不能把 calls 当成真的 0）。 */
export const FeishuUsageSnapshot = z.strictObject({
  /** 北京时间的自然月。 */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  calls: z.number().int().min(0),
  limit: z.number().int().positive(),
  readable: z.boolean(),
});

const OpenIdTail = z.string().length(4);
const OutsiderReason = z.string().min(1).max(200);

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

/**
 * 意图卡的样子（api 的 intents.ts composeCard 拼，存意图表的卡状态用）。网关不再收这张卡、也不再发：
 * 飞书上不再有意图卡，这里只为已有的意图数据和 `fleet-api intent` 读得懂。
 */
export const IntentCardSchema = z.object({
  intentId: Id,
  seq: z.number().int().positive(),
  /** 卡的第几版。 */
  cardRev: z.number().int().positive(),
  chatId: FeishuId,
  /** 当时回复的是这段的第一条原话。 */
  replyToMessageId: FeishuId,
  /** 已经发过的那张。 */
  cardMessageId: FeishuId.optional(),
  /** 标题一行，下面每行一段。 */
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

/** 卡的回执：发了、改了只认飞书回的消息编号；没发成带原因。 */
export const IntentCardAckSchema = z.object({
  intentId: Id,
  cardRev: z.number().int().positive(),
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('sent'), messageId: FeishuId }),
    z.object({ status: z.literal('updated'), messageId: FeishuId }),
    z.object({ status: z.literal('failed'), error: z.string().min(1).max(500) }),
  ]),
});

// —— 路由表（路径都在 WEB_API_PREFIX 之下）。后端按每条的 acting 放行 ——

export const IntentRoutes = {
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
