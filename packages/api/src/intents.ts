// 意图（#553 第 4 条，specs/553-对题/方案.md 末节「2026-10-04 拍板」）的判法只有这一份：切段（这句归哪段）、同一条消息
// 再来算重放还是改过、卡什么时候该发、卡上写什么、给指挥官看的样子。内存版和 Postgres 版存储（intent-store*.ts）都照它。
// 改这里之前必须知道：
// - 原话原样：这里只排序、计数、拼卡上的字，从不改原话；AI 归纳只在指挥官写回之后才上卡，永远不进原话。
// - 切段按顺序判，第一条命中就定：「@机器人 另起」→ 同一个话题 → 回复了某段里的话或某段的卡 → 同一会话 15 分钟内。
//   「另起」放第一（方案 5.1 写的是第三）：它是人明说的口令，回复卡、在话题里说「另起」也该另起。
//   要接的那段已经开成单或放下了，就另起一段、记下接着哪段，不往开成的单里塞。
// - 时刻一律 ISO 字符串（和 ports.ts 一样）；卡上的时刻按北京时间（没有夏令时，固定 +8）。
import { createHash } from 'node:crypto';
import type {
  IntentCardSchema,
  IntentChatKindSchema,
  IntentDetailSchema,
  IntentMessageSourceSchema,
  IntentStatusSchema,
} from '@fleet-dao/shared';
import type { z } from 'zod';

export type IntentStatus = z.infer<typeof IntentStatusSchema>;
export type IntentChatKind = z.infer<typeof IntentChatKindSchema>;
export type IntentMessageSource = z.infer<typeof IntentMessageSourceSchema>;
export type IntentDetail = z.infer<typeof IntentDetailSchema>;
export type IntentCard = z.infer<typeof IntentCardSchema>;

/** 同一会话里两句话隔多久以内算同一段。 */
export const SEGMENT_WINDOW_MS = 15 * 60_000;
/** 停下来多久出卡：私聊 90 秒，群里 5 分钟（不在两人说到一半时插一张卡）。@机器人 的马上出。 */
export const CARD_QUIET_MS: Readonly<Record<IntentChatKind, number>> = { p2p: 90_000, group: 5 * 60_000 };
/** 卡连着没发成：第 n 次之后隔多久再给网关（第 4 次起每小时一次，不停：卡是「说了就算交出去了」的回执）。 */
const CARD_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export interface IntentLink {
  issue: string;
  by: string;
  at: string;
}

export interface IntentEdit {
  text: string;
  rawContent: string;
  contentHash: string;
  replacedAt: string;
}

export interface IntentRecord {
  id: string;
  seq: number;
  chatId: string;
  chatKind: IntentChatKind;
  threadId?: string | undefined;
  status: IntentStatus;
  continuesSeq?: number | undefined;
  revision: number;
  firstMessageId: string;
  firstMessageAt: string;
  lastMessageAt: string;
  summary?: { text: string; by: string; at: string; covers: number } | undefined;
  links: IntentLink[];
  dropped?: { reason: string; by: string; at: string } | undefined;
  card: {
    rev: number;
    shownRev?: number | undefined;
    messageId?: string | undefined;
    dueAt?: string | undefined;
    attempts: number;
    error?: string | undefined;
  };
}

export interface IntentMessageRecord {
  messageId: string;
  intentId: string;
  chatId: string;
  threadId?: string | undefined;
  parentId?: string | undefined;
  senderUserId: string;
  senderName: string;
  sentAt: string;
  receivedAt: string;
  source: IntentMessageSource;
  msgType: string;
  text: string;
  rawContent: string;
  contentHash: string;
  atBot: boolean;
  forward?: { of: string; senderName?: string | undefined } | undefined;
  editedAt?: string | undefined;
  edits: IntentEdit[];
  recalledAt?: string | undefined;
}

export interface IntentWithMessages {
  intent: IntentRecord;
  messages: IntentMessageRecord[];
}

/** 飞书原始内容的摘要：同一个消息编号再来，靠它判内容变没变（网关换了规范化写法也不会误判）。 */
export function contentHash(rawContent: string): string {
  return createHash('sha256').update(rawContent, 'utf8').digest('hex');
}

// —— 切段 ——

export interface SegmentCandidate {
  id: string;
  seq: number;
  status: IntentStatus;
  threadId?: string | undefined;
}

export interface SegmentFacts {
  sentAt: string;
  threadId?: string | undefined;
  /** 「@机器人 另起」。 */
  newSegment: boolean;
  /** 同一会话里同一个话题最近开的那段。 */
  thread?: SegmentCandidate | undefined;
  /** parentId 指到的那段：回复了某段里的话，或回复了某段的意图卡。 */
  parent?: SegmentCandidate | undefined;
  /** 同一会话、不在话题里、发出时刻不晚于这条的最近一条原话，和它所在的那段。 */
  before?: { at: string; intent: SegmentCandidate } | undefined;
  /** 同一会话、不在话题里、发出时刻晚于这条的最早一条（补漏乱序时才会有）。 */
  after?: { at: string; intent: SegmentCandidate } | undefined;
}

export type SegmentRule = 'command' | 'thread' | 'reply' | 'window' | 'fresh';

export type SegmentDecision =
  | { kind: 'join'; intentId: string; rule: SegmentRule; adoptThread?: string | undefined }
  | { kind: 'new'; rule: SegmentRule; continuesId?: string | undefined; threadId?: string | undefined };

/** 这句归哪段：按顺序判，第一条命中就定（见文件开头）。 */
export function decideSegment(f: SegmentFacts): SegmentDecision {
  const into = (c: SegmentCandidate, rule: SegmentRule, threadId?: string): SegmentDecision =>
    c.status === 'new'
      ? {
          kind: 'join',
          intentId: c.id,
          rule,
          ...(threadId !== undefined && c.threadId === undefined ? { adoptThread: threadId } : {}),
        }
      : { kind: 'new', rule, continuesId: c.id, ...(threadId === undefined ? {} : { threadId }) };

  if (f.newSegment) {
    return { kind: 'new', rule: 'command', ...(f.threadId === undefined ? {} : { threadId: f.threadId }) };
  }
  if (f.threadId !== undefined) {
    if (f.thread) return into(f.thread, 'thread', f.threadId);
    if (f.parent) return into(f.parent, 'reply', f.threadId);
    return { kind: 'new', rule: 'fresh', threadId: f.threadId };
  }
  if (f.parent) return into(f.parent, 'reply');
  const at = Date.parse(f.sentAt);
  const near = (x: { at: string } | undefined) =>
    x !== undefined && Math.abs(at - Date.parse(x.at)) < SEGMENT_WINDOW_MS;
  if (f.before && near(f.before)) return into(f.before.intent, 'window');
  if (f.after && near(f.after)) return into(f.after.intent, 'window');
  return { kind: 'new', rule: 'fresh' };
}

// —— 同一条消息再来 ——

export type RepeatVerdict =
  | { kind: 'replayed' }
  | { kind: 'edit' }
  /** 比存下的那版还旧的一版晚到了：记进旧版本里，最新的不动。 */
  | { kind: 'older_edit' }
  | { kind: 'reused'; why: string };

/** 同一个消息编号再来：重放、改过的新一版、晚到的旧一版，还是网关出了错（换了人、换了会话、换了内容又没说改过）。 */
export function judgeRepeat(
  stored: Pick<IntentMessageRecord, 'senderUserId' | 'chatId' | 'contentHash' | 'edits' | 'editedAt'>,
  incoming: { senderUserId: string; chatId: string; contentHash: string; editedAt?: string | undefined },
): RepeatVerdict {
  if (stored.senderUserId !== incoming.senderUserId) {
    return { kind: 'reused', why: '这个飞书消息编号已经记在另一个人名下了' };
  }
  if (stored.chatId !== incoming.chatId) {
    return { kind: 'reused', why: '这个飞书消息编号已经记在另一个会话里了' };
  }
  const known =
    stored.contentHash === incoming.contentHash ||
    stored.edits.some((e) => e.contentHash === incoming.contentHash);
  if (known) return { kind: 'replayed' };
  if (incoming.editedAt === undefined) {
    return { kind: 'reused', why: '这个飞书消息编号已经存过别的内容，这次又没说是改过的' };
  }
  if (stored.editedAt === undefined || Date.parse(incoming.editedAt) > Date.parse(stored.editedAt)) {
    return { kind: 'edit' };
  }
  return { kind: 'older_edit' };
}

/** 改过的新一版到了：旧的那版进 edits（旧的在前），最新的换上。 */
export function applyEdit(
  stored: IntentMessageRecord,
  incoming: { text: string; rawContent: string; contentHash: string; editedAt: string; msgType: string },
): IntentMessageRecord {
  return {
    ...stored,
    msgType: incoming.msgType,
    text: incoming.text,
    rawContent: incoming.rawContent,
    contentHash: incoming.contentHash,
    editedAt: incoming.editedAt,
    edits: [
      ...stored.edits,
      {
        text: stored.text,
        rawContent: stored.rawContent,
        contentHash: stored.contentHash,
        replacedAt: incoming.editedAt,
      },
    ],
  };
}

/** 晚到的旧一版：按被改掉的时刻插进旧版本里（最新的那版不动）。 */
export function insertOlderEdit(
  stored: IntentMessageRecord,
  incoming: { text: string; rawContent: string; contentHash: string; editedAt: string },
): IntentMessageRecord {
  const edits = [
    ...stored.edits,
    {
      text: incoming.text,
      rawContent: incoming.rawContent,
      contentHash: incoming.contentHash,
      replacedAt: incoming.editedAt,
    },
  ].sort((a, b) => Date.parse(a.replacedAt) - Date.parse(b.replacedAt));
  return { ...stored, edits };
}

// —— 卡什么时候该发 ——

/** 卡上看得出的变化之后，卡该在什么时候发（改）：急的（@机器人、写回归纳、开成单、放下）马上，别的等停下来。 */
export function cardDueAt(chatKind: IntentChatKind, now: Date, urgent: boolean): string {
  return new Date(now.getTime() + (urgent ? 0 : CARD_QUIET_MS[chatKind])).toISOString();
}

/** 卡第 attempts 次没发成之后，什么时候再给网关。 */
export function cardRetryAt(attempts: number, now: Date): string {
  const wait = CARD_RETRY_MS[Math.min(Math.max(attempts, 1), CARD_RETRY_MS.length) - 1] ?? 60 * 60_000;
  return new Date(now.getTime() + wait).toISOString();
}

// —— 排序、卡上的字、给指挥官看的样子 ——

/** 一段里的原话按发出时刻排（同一刻按编号），撤回的也占号。 */
export function orderMessages(messages: readonly IntentMessageRecord[]): IntentMessageRecord[] {
  return [...messages].sort(
    (a, b) =>
      Date.parse(a.sentAt) - Date.parse(b.sentAt) ||
      (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0),
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 北京时间「10-04 14:02」。 */
export function beijingStamp(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 60 * 60_000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 「10-04 14:02–14:09」；跨天写全两头。 */
export function beijingRange(fromIso: string, toIso: string): string {
  const from = beijingStamp(fromIso);
  const to = beijingStamp(toIso);
  if (from === to) return from;
  return from.slice(0, 5) === to.slice(0, 5) ? `${from}–${to.slice(6)}` : `${from}–${to}`;
}

/** 「甲 2 条、乙 1 条、转发 3 条」：只数没撤回的；转发进来的不算成转发的人说的。 */
function speakers(live: readonly IntentMessageRecord[]): string {
  const counts = new Map<string, number>();
  let forwarded = 0;
  for (const m of live) {
    if (m.forward) forwarded += 1;
    else counts.set(m.senderName, (counts.get(m.senderName) ?? 0) + 1);
  }
  const parts = [...counts].map(([name, n]) => `${name} ${n} 条`);
  if (forwarded > 0) parts.push(`转发 ${forwarded} 条`);
  return parts.length > 0 ? parts.join('、') : '原话都撤回了';
}

const TITLE_MAX = 300;
const clipTitle = (s: string) => (s.length <= TITLE_MAX ? s : `${s.slice(0, TITLE_MAX - 1)}…`);

/** 卡上的字（网关照着发，没有按钮）。 */
export function composeCard(intent: IntentRecord, messages: readonly IntentMessageRecord[]): IntentCard {
  const ordered = orderMessages(messages);
  const live = ordered.filter((m) => m.recalledAt === undefined);
  const recalled = ordered.length - live.length;
  let title: string;
  if (intent.status === 'linked') {
    title = `意图 ${intent.seq} · 已开成 ${intent.links.map((l) => l.issue).join('、')}`;
  } else if (intent.status === 'dropped') {
    title = `意图 ${intent.seq} · 已放下`;
  } else {
    title = `意图 ${intent.seq} · 已存 ${live.length} 条原话`;
  }
  const lines = [
    `${speakers(live)} · ${beijingRange(intent.firstMessageAt, intent.lastMessageAt)}（北京时间）`,
  ];
  if (intent.status === 'dropped' && intent.dropped) lines.push(`理由：${intent.dropped.reason}`);
  if (recalled > 0) lines.push(`其中 ${recalled} 条已在飞书撤回，不进单子`);
  if (intent.summary) {
    const later = ordered.length - intent.summary.covers;
    lines.push(
      `AI 归纳（${intent.summary.by} 写的，不是原话 · ${beijingStamp(intent.summary.at)} · 覆盖到第 ${intent.summary.covers} 条）：${intent.summary.text}${later > 0 ? `（之后又来了 ${later} 条）` : ''}`,
    );
  } else if (intent.status === 'new') {
    lines.push('AI 归纳：对题开单时由指挥官写，写好会更新在这里。');
  }
  return {
    intentId: intent.id,
    seq: intent.seq,
    cardRev: intent.card.rev,
    chatId: intent.chatId,
    // 撤回了的话飞书不让回复：回复在第一条没撤回的下面
    replyToMessageId: live[0]?.messageId ?? intent.firstMessageId,
    ...(intent.card.messageId === undefined ? {} : { cardMessageId: intent.card.messageId }),
    title: clipTitle(title),
    lines,
  };
}

/** 给指挥官看的样子（fleet-api intent … --json 打的就是它）。 */
export function intentDetail(intent: IntentRecord, messages: readonly IntentMessageRecord[]): IntentDetail {
  const firstLinkAt = intent.links.length > 0 ? Math.min(...intent.links.map((l) => Date.parse(l.at))) : null;
  return {
    id: intent.id,
    seq: intent.seq,
    status: intent.status,
    chatId: intent.chatId,
    chatKind: intent.chatKind,
    ...(intent.threadId === undefined ? {} : { threadId: intent.threadId }),
    ...(intent.continuesSeq === undefined ? {} : { continuesSeq: intent.continuesSeq }),
    revision: intent.revision,
    firstMessageAt: intent.firstMessageAt,
    lastMessageAt: intent.lastMessageAt,
    messages: orderMessages(messages).map((m, i) => ({
      messageId: m.messageId,
      ord: i + 1,
      senderUserId: m.senderUserId,
      senderName: m.senderName,
      sentAt: m.sentAt,
      receivedAt: m.receivedAt,
      source: m.source,
      msgType: m.msgType,
      text: m.text,
      ...(m.threadId === undefined ? {} : { threadId: m.threadId }),
      ...(m.parentId === undefined ? {} : { parentId: m.parentId }),
      ...(m.forward === undefined
        ? {}
        : {
            forward: {
              of: m.forward.of,
              ...(m.forward.senderName === undefined ? {} : { senderName: m.forward.senderName }),
            },
          }),
      ...(m.editedAt === undefined ? {} : { editedAt: m.editedAt }),
      edits: m.edits.map((e) => ({ text: e.text, replacedAt: e.replacedAt })),
      ...(m.recalledAt === undefined ? {} : { recalledAt: m.recalledAt }),
      recalledAfterLink:
        m.recalledAt !== undefined && firstLinkAt !== null && Date.parse(m.recalledAt) > firstLinkAt,
    })),
    ...(intent.summary === undefined ? {} : { summary: { ...intent.summary } }),
    links: intent.links.map((l) => ({ ...l })),
    ...(intent.dropped === undefined ? {} : { dropped: { ...intent.dropped } }),
    card: {
      ...(intent.card.messageId === undefined ? {} : { messageId: intent.card.messageId }),
      ...(intent.card.shownRev === undefined ? {} : { shownRev: intent.card.shownRev }),
      rev: intent.card.rev,
      ...(intent.card.dueAt === undefined ? {} : { dueAt: intent.card.dueAt }),
      attempts: intent.card.attempts,
      ...(intent.card.error === undefined ? {} : { error: intent.card.error }),
    },
  };
}
