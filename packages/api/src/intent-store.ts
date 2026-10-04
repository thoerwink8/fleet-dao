// 意图的存储口（#553 第 4 条）：网关收原话、收撤回、问补漏游标、取要发的卡、回执；指挥官读、写回归纳和「已开成 #N」、放下。
// 两份实现过同一套契约测试（test/intent-store-contract.ts）：这里的内存版（开发环境、测试），intent-store-pg.ts 的 Postgres 版。
// 改这里之前必须知道：
// - 判法（切段、重放还是改过、卡什么时候发、写回和放下让不让）只在 intents.ts 一份，两份存储只负责把要判的事实找齐、
//   照结论写。
// - 读不到、写不进、库里的东西认不出一律抛（调用方回 5xx 或非 0 退出码写明原因），不拿空列表、0 冒充「没有」。
// - 写回归纳、开成单、放下和操作记录在同一个事务里：记不下就不改（Postgres 版）。
import type { IntentCardAckSchema } from '@fleet-dao/shared';
import type { z } from 'zod';
import {
  applyEdit,
  bumped,
  cardDueAt,
  contentHash,
  decideSegment,
  hasLiveMessage,
  type IntentChatKind,
  type IntentMessageRecord,
  type IntentMessageSource,
  type IntentRecord,
  type IntentStatus,
  type IntentWithMessages,
  insertOlderEdit,
  judgeRepeat,
  orderMessages,
  planAck,
  planDrop,
  planLink,
  type SegmentCandidate,
  type SegmentRule,
} from './intents.ts';
import type { NewAuditEntry } from './ports.ts';

export interface IntakeMessage {
  messageId: string;
  chatId: string;
  chatKind: IntentChatKind;
  threadId?: string | undefined;
  parentId?: string | undefined;
  sentAt: string;
  editedAt?: string | undefined;
  source: IntentMessageSource;
  msgType: string;
  text: string;
  rawContent: string;
  atBot: boolean;
  newSegment: boolean;
  forward?: { of: string; senderName?: string | undefined } | undefined;
  senderUserId: string;
  senderName: string;
}

export type IntakeMessageResult =
  | {
      status: 'stored' | 'replayed' | 'edited' | 'recalled';
      intentId: string;
      intentSeq: number;
      /** 新存的这条按哪条规矩归的段（重放、改过的没有）。 */
      rule?: SegmentRule | undefined;
    }
  | { status: 'reused'; why: string };

export interface IntakeRecall {
  messageId: string;
  chatId: string;
  recalledAt: string;
  source: IntentMessageSource;
}

export type IntakeRecallResult =
  | { status: 'recalled' | 'already'; intentSeq: number }
  | { status: 'tombstone' }
  | { status: 'reused'; why: string };

export interface ChatCursor {
  chatId: string;
  chatKind: IntentChatKind;
  lastSentAt: string;
  lastMessageId: string;
  messages: number;
}

export interface DueCards {
  items: IntentWithMessages[];
  /** 下一张卡几点到期（长轮询睡到那时）；没有就是眼下没有排着的。 */
  nextDueAt?: string | undefined;
}

export type CardAck = z.infer<typeof IntentCardAckSchema>;

export interface CardAckReport {
  applied: number;
  skipped: { intentId: string; why: string }[];
}

export interface LinkInput {
  seq: number;
  issue: string;
  summary: { text: string; by: string };
  /** 谁挂的（服务器上跑命令的人）。 */
  operator: string;
  /** 已经开成了别的单，还要再挂这一张（并进已有的单、一段开成两张）。 */
  relink: boolean;
}

export type LinkResult =
  | { status: 'linked' | 'added' | 'updated'; intent: IntentWithMessages }
  | { status: 'not_found' }
  | { status: 'already_linked'; issues: string[] }
  | { status: 'empty' };

export interface DropInput {
  seq: number;
  reason: string;
  operator: string;
}

export type DropResult =
  | { status: 'dropped' | 'already'; intent: IntentWithMessages }
  | { status: 'not_found' }
  | { status: 'linked'; issues: string[] };

/** 写回归纳、开成单、放下的操作记录：前后两个值由存储按库里实际的填。 */
export type IntentAudit = Omit<NewAuditEntry, 'before' | 'after'>;

export interface IntentListFilter {
  status: IntentStatus | 'all';
  limit: number;
}

export interface IntentStore {
  intakeMessage(m: IntakeMessage): Promise<IntakeMessageResult>;
  intakeRecall(r: IntakeRecall): Promise<IntakeRecallResult>;
  /** 带 chatId 只看这一个（没见过就是空列表，由接口回 known=false）；不带回全部见过的会话。 */
  cursors(chatId?: string): Promise<ChatCursor[]>;
  /** 到期、卡又不是最新的那些段（按到期先后，最多 limit 段）。一条原话都没剩、卡也没发过的不给（没什么可回执的）。 */
  dueCards(limit: number): Promise<DueCards>;
  /** 按条处理回执：认不出的（没有这段、版本比库里新）跳过并写明，不让整批失败。 */
  ackCards(acks: readonly CardAck[]): Promise<CardAckReport>;
  list(filter: IntentListFilter): Promise<IntentWithMessages[]>;
  get(seq: number): Promise<IntentWithMessages | null>;
  link(input: LinkInput, audit: IntentAudit): Promise<LinkResult>;
  drop(input: DropInput, audit: IntentAudit): Promise<DropResult>;
}

/** 写回、开单、放下进操作记录时「改之前、改之后」写什么：状态、挂的单、归纳是谁几点写的（归纳正文不进，单子里有）。 */
export function auditShape(i: IntentRecord) {
  return {
    seq: i.seq,
    status: i.status,
    links: i.links.map((l) => l.issue),
    summaryBy: i.summary?.by ?? null,
    summaryAt: i.summary?.at ?? null,
    dropReason: i.dropped?.reason ?? null,
  };
}

// —— 内存版 ——

type MemoryIntent = IntentRecord & { continuesId?: string | undefined };

export interface MemoryIntentData {
  intents: MemoryIntent[];
  messages: IntentMessageRecord[];
  recalls: {
    messageId: string;
    chatId: string;
    recalledAt: string;
    receivedAt: string;
    source: IntentMessageSource;
  }[];
  nextSeq: number;
}

export interface MemoryIntentStore extends IntentStore {
  data: MemoryIntentData;
  audits: NewAuditEntry[];
}

export function createMemoryIntentStore(options: { now?: () => Date } = {}): MemoryIntentStore {
  const now = options.now ?? (() => new Date());
  const data: MemoryIntentData = { intents: [], messages: [], recalls: [], nextSeq: 1 };
  const audits: NewAuditEntry[] = [];

  const candidate = (i: IntentRecord): SegmentCandidate => ({
    id: i.id,
    seq: i.seq,
    status: i.status,
    threadId: i.threadId,
  });
  const intentById = (id: string): MemoryIntent => {
    const i = data.intents.find((x) => x.id === id);
    if (!i) throw new Error(`意图 ${id} 读不到`);
    return i;
  };
  const messagesOf = (intentId: string) => data.messages.filter((m) => m.intentId === intentId);
  const withMessages = (i: MemoryIntent): IntentWithMessages => {
    const { continuesId: _internal, ...intent } = i;
    return structuredClone({ intent, messages: orderMessages(messagesOf(i.id)) });
  };
  /** 换掉一段（照判法算出的下一版），内部的 continuesId 留着。 */
  const replace = (i: MemoryIntent, next: IntentRecord) => {
    Object.assign(i, next);
  };
  /** 主流（不在话题里）的原话按发出时刻排。 */
  const mainFlow = (chatId: string) =>
    orderMessages(data.messages.filter((m) => m.chatId === chatId && m.threadId === undefined));
  const at = (iso: string) => Date.parse(iso);

  return {
    data,
    audits,

    async intakeMessage(m) {
      const hash = contentHash(m.rawContent);
      const stored = data.messages.find((x) => x.messageId === m.messageId);
      if (stored) {
        const intent = intentById(stored.intentId);
        const verdict = judgeRepeat(stored, {
          senderUserId: m.senderUserId,
          chatId: m.chatId,
          contentHash: hash,
          editedAt: m.editedAt,
        });
        if (verdict.kind === 'reused') return { status: 'reused', why: verdict.why };
        if (verdict.kind === 'replayed')
          return { status: 'replayed', intentId: intent.id, intentSeq: intent.seq };
        if (m.editedAt === undefined) throw new Error('判成了改过的一版，请求里却没有改动时刻');
        const incoming = {
          text: m.text,
          rawContent: m.rawContent,
          contentHash: hash,
          editedAt: m.editedAt,
          msgType: m.msgType,
        };
        Object.assign(
          stored,
          verdict.kind === 'edit' ? applyEdit(stored, incoming) : insertOlderEdit(stored, incoming),
        );
        replace(intent, bumped(intent, now(), null));
        return { status: 'edited', intentId: intent.id, intentSeq: intent.seq };
      }

      const tomb = data.recalls.find((r) => r.messageId === m.messageId);
      const flow = m.threadId === undefined ? mainFlow(m.chatId) : [];
      const before = [...flow].reverse().find((x) => at(x.sentAt) <= at(m.sentAt));
      const after = flow.find((x) => at(x.sentAt) > at(m.sentAt));
      const near = (x: IntentMessageRecord | undefined) =>
        x && { at: x.sentAt, intent: candidate(intentById(x.intentId)) };
      const thread =
        m.threadId === undefined
          ? undefined
          : data.intents
              .filter((i) => i.chatId === m.chatId && i.threadId === m.threadId)
              .sort((a, b) => b.seq - a.seq)[0];
      let parent: MemoryIntent | undefined;
      if (m.parentId !== undefined) {
        const parentMessage = data.messages.find((x) => x.messageId === m.parentId);
        parent = parentMessage
          ? intentById(parentMessage.intentId)
          : data.intents.find((i) => i.card.messageId === m.parentId);
      }
      const decision = decideSegment({
        sentAt: m.sentAt,
        threadId: m.threadId,
        newSegment: m.newSegment,
        thread: thread && candidate(thread),
        parent: parent && candidate(parent),
        before: near(before),
        after: near(after),
      });

      let intent: MemoryIntent;
      if (decision.kind === 'join') {
        intent = intentById(decision.intentId);
        const next = bumped(intent, now(), { urgent: m.atBot });
        if (decision.adoptThread !== undefined) next.threadId = decision.adoptThread;
        if (at(m.sentAt) < at(intent.firstMessageAt)) {
          next.firstMessageAt = m.sentAt;
          next.firstMessageId = m.messageId;
        }
        if (at(m.sentAt) > at(intent.lastMessageAt)) next.lastMessageAt = m.sentAt;
        replace(intent, next);
      } else {
        const continues = decision.continuesId === undefined ? undefined : intentById(decision.continuesId);
        intent = {
          id: crypto.randomUUID(),
          seq: data.nextSeq++,
          chatId: m.chatId,
          chatKind: m.chatKind,
          threadId: decision.threadId,
          status: 'new',
          continuesId: continues?.id,
          continuesSeq: continues?.seq,
          revision: 1,
          firstMessageId: m.messageId,
          firstMessageAt: m.sentAt,
          lastMessageAt: m.sentAt,
          links: [],
          card: { rev: 1, attempts: 0, dueAt: cardDueAt(m.chatKind, now(), m.atBot) },
        };
        data.intents.push(intent);
      }
      data.messages.push({
        messageId: m.messageId,
        intentId: intent.id,
        chatId: m.chatId,
        threadId: m.threadId,
        parentId: m.parentId,
        senderUserId: m.senderUserId,
        senderName: m.senderName,
        sentAt: m.sentAt,
        receivedAt: now().toISOString(),
        source: m.source,
        msgType: m.msgType,
        text: m.text,
        rawContent: m.rawContent,
        contentHash: hash,
        atBot: m.atBot,
        forward: m.forward,
        editedAt: m.editedAt,
        edits: [],
        recalledAt: tomb?.recalledAt,
      });
      return {
        status: tomb ? 'recalled' : 'stored',
        intentId: intent.id,
        intentSeq: intent.seq,
        rule: decision.rule,
      };
    },

    async intakeRecall(r) {
      const stored = data.messages.find((m) => m.messageId === r.messageId);
      const tomb = data.recalls.find((x) => x.messageId === r.messageId);
      if (stored && stored.chatId !== r.chatId) {
        return { status: 'reused', why: '要撤回的这条原话记在另一个会话里' };
      }
      if (tomb && tomb.chatId !== r.chatId) {
        return { status: 'reused', why: '这个消息编号的撤回已经记在另一个会话里' };
      }
      if (!tomb) data.recalls.push({ ...r, receivedAt: now().toISOString() });
      if (!stored) return { status: 'tombstone' };
      const intent = intentById(stored.intentId);
      if (stored.recalledAt !== undefined) return { status: 'already', intentSeq: intent.seq };
      stored.recalledAt = r.recalledAt;
      replace(intent, bumped(intent, now(), { urgent: false }));
      return { status: 'recalled', intentSeq: intent.seq };
    },

    async cursors(chatId) {
      const byChat = new Map<string, IntentMessageRecord[]>();
      for (const m of data.messages) {
        if (chatId !== undefined && m.chatId !== chatId) continue;
        byChat.set(m.chatId, [...(byChat.get(m.chatId) ?? []), m]);
      }
      return [...byChat].map(([id, list]) => {
        const ordered = orderMessages(list);
        const last = ordered[ordered.length - 1];
        if (!last) throw new Error(`会话 ${id} 一条原话都没有，却列进了游标`);
        return {
          chatId: id,
          chatKind: intentById(last.intentId).chatKind,
          lastSentAt: last.sentAt,
          lastMessageId: last.messageId,
          messages: list.length,
        };
      });
    },

    async dueCards(limit) {
      const t = now().getTime();
      const pending = data.intents
        .filter(
          (i) =>
            i.card.dueAt !== undefined &&
            (i.card.shownRev === undefined || i.card.shownRev < i.card.rev) &&
            (i.card.messageId !== undefined || hasLiveMessage(messagesOf(i.id))),
        )
        .sort((a, b) => at(a.card.dueAt ?? '') - at(b.card.dueAt ?? '') || a.seq - b.seq);
      const due = pending.filter((i) => at(i.card.dueAt ?? '') <= t);
      const later = pending.find((i) => at(i.card.dueAt ?? '') > t);
      return {
        items: due.slice(0, limit).map(withMessages),
        ...(later ? { nextDueAt: later.card.dueAt } : {}),
      };
    },

    async ackCards(acks) {
      const report: CardAckReport = { applied: 0, skipped: [] };
      for (const ack of acks) {
        const intent = data.intents.find((x) => x.id === ack.intentId);
        if (!intent) {
          report.skipped.push({ intentId: ack.intentId, why: '没有这段意图' });
          continue;
        }
        const plan = planAck(intent, ack, now());
        if (plan.kind === 'skip') {
          report.skipped.push({ intentId: ack.intentId, why: plan.why });
          continue;
        }
        intent.card = plan.card;
        report.applied += 1;
      }
      return report;
    },

    async list(filter) {
      return data.intents
        .filter((i) => filter.status === 'all' || i.status === filter.status)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, filter.limit)
        .map(withMessages);
    },

    async get(seq) {
      const i = data.intents.find((x) => x.seq === seq);
      return i ? withMessages(i) : null;
    },

    async link(input, audit) {
      const intent = data.intents.find((x) => x.seq === input.seq);
      if (!intent) return { status: 'not_found' };
      const plan = planLink(intent, messagesOf(intent.id), input, now());
      if (plan.status === 'empty' || plan.status === 'already_linked') return plan;
      audits.push({ ...audit, before: auditShape(intent), after: auditShape(plan.next) });
      replace(intent, plan.next);
      return { status: plan.status, intent: withMessages(intent) };
    },

    async drop(input, audit) {
      const intent = data.intents.find((x) => x.seq === input.seq);
      if (!intent) return { status: 'not_found' };
      const plan = planDrop(intent, input, now());
      if (plan.status === 'linked') return plan;
      if (plan.status === 'already') return { status: 'already', intent: withMessages(intent) };
      audits.push({ ...audit, before: auditShape(intent), after: auditShape(plan.next) });
      replace(intent, plan.next);
      return { status: 'dropped', intent: withMessages(intent) };
    },
  };
}
