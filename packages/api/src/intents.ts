// 意图（#553 第 4 条，specs/553-对题/方案.md 末节「2026-10-04 拍板」）的判法只有这一份：写回归纳、放下让不让，
// 卡上写什么、给指挥官看的样子。内存版和 Postgres 版存储（intent-store*.ts）都照它。飞书收缩后（F1 #2051）网关不再写意图库，
// 切段、重放和改过、撤回、卡的回执这些收话的判法已删；库里已有的意图和原话照旧能读。
// 改这里之前必须知道：
// - 原话原样：这里只排序、计数、拼卡上的字，从不改原话；AI 归纳只在指挥官写回之后才上卡，永远不进原话。
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

/** 停下来多久出卡：私聊 90 秒，群里 5 分钟（不在两人说到一半时插一张卡）。@机器人 的马上出。 */
export const CARD_QUIET_MS: Readonly<Record<IntentChatKind, number>> = { p2p: 90_000, group: 5 * 60_000 };
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

// —— 卡什么时候该发 ——

/** 卡上看得出的变化之后，卡该在什么时候发（改）：急的（@机器人、写回归纳、开成单、放下）马上，别的等停下来。 */
export function cardDueAt(chatKind: IntentChatKind, now: Date, urgent: boolean): string {
  return new Date(now.getTime() + (urgent ? 0 : CARD_QUIET_MS[chatKind])).toISOString();
}

/** 这段改了：版本加 1；卡上看得出的（card 不是 null）卡的版本也加 1、按急不急定到期。改字只加版本。 */
export function bumped(i: IntentRecord, now: Date, card: { urgent: boolean } | null): IntentRecord {
  return {
    ...i,
    revision: i.revision + 1,
    card: card ? { ...i.card, rev: i.card.rev + 1, dueAt: cardDueAt(i.chatKind, now, card.urgent) } : i.card,
  };
}

/** 这段一条可读的原话都没有（全撤回了）：开不了单。 */
export const hasLiveMessage = (messages: readonly IntentMessageRecord[]) =>
  messages.some((m) => m.recalledAt === undefined);

export type LinkPlan =
  | { status: 'linked' | 'added' | 'updated'; next: IntentRecord }
  | { status: 'already_linked'; issues: string[] }
  | { status: 'empty' };

/**
 * 指挥官开单时写回：归纳（谁写的、几点、这时有几条原话）+ 开成的单。同一张单再写只更新归纳、不多记一笔；已经开成了
 * 别的单，不带 relink 不挂（一段开成两张、并进已有的单要明说）。放下过的照样能开成单（理由留着当历史）。
 */
export function planLink(
  i: IntentRecord,
  messages: readonly IntentMessageRecord[],
  input: { issue: string; summary: { text: string; by: string }; operator: string; relink: boolean },
  now: Date,
): LinkPlan {
  if (!hasLiveMessage(messages)) return { status: 'empty' };
  const already = i.links.some((l) => l.issue === input.issue);
  const others = i.links.filter((l) => l.issue !== input.issue).map((l) => l.issue);
  if (!already && others.length > 0 && !input.relink) return { status: 'already_linked', issues: others };
  const at = now.toISOString();
  const next: IntentRecord = {
    ...bumped(i, now, { urgent: true }),
    status: 'linked',
    summary: { text: input.summary.text, by: input.summary.by, at, covers: messages.length },
    links: already ? i.links : [...i.links, { issue: input.issue, by: input.operator, at }],
  };
  return { status: already ? 'updated' : i.links.length > 0 ? 'added' : 'linked', next };
}

export type DropPlan =
  | { status: 'dropped'; next: IntentRecord }
  | { status: 'already' }
  | { status: 'linked'; issues: string[] };

/** 放下（闲聊、重复的）：开成了单的不能放下；放下过的不再改理由。 */
export function planDrop(i: IntentRecord, input: { reason: string; operator: string }, now: Date): DropPlan {
  if (i.status === 'linked') return { status: 'linked', issues: i.links.map((l) => l.issue) };
  if (i.status === 'dropped') return { status: 'already' };
  return {
    status: 'dropped',
    next: {
      ...bumped(i, now, { urgent: true }),
      status: 'dropped',
      dropped: { reason: input.reason, by: input.operator, at: now.toISOString() },
    },
  };
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
