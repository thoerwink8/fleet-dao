// 测试里往意图库放「飞书收缩前网关已经存下的」意图和原话：网关不再写意图库（F1 #2051），存储口上没有收原话的方法，
// 读和写回的测试直接往库里放数据。内存版放进 data，Postgres 版直接插两张表。
import { type Db, intentMessages, intents } from '@fleet-dao/db';
import { IDS } from '@fleet-dao/store';
import type { MemoryIntentStore } from '../src/intent-store.ts';
import { contentHash, type IntentChatKind, type IntentMessageRecord } from '../src/intents.ts';

export interface SeedMessage {
  text: string;
  sentAt: string;
  messageId?: string;
  senderUserId?: string;
  senderName?: string;
  recalledAt?: string;
}

export interface SeedIntent {
  chatId?: string;
  chatKind?: IntentChatKind;
  messages: SeedMessage[];
}

/** 放一段意图（状态 new、卡没排期）。返回它的号。 */
export type SeedFn = (spec: SeedIntent) => Promise<number>;

let counter = 0;

function filled(spec: SeedIntent, receivedAt: string) {
  if (spec.messages.length === 0) throw new Error('放一段意图至少要有一条原话');
  const chatId = spec.chatId ?? 'oc_team';
  const messages = spec.messages.map((m) => {
    counter += 1;
    const rawContent = JSON.stringify({ text: m.text });
    return {
      messageId: m.messageId ?? `om_seed_${counter}`,
      chatId,
      senderUserId: m.senderUserId ?? IDS.founderA,
      senderName: m.senderName ?? '创始人甲',
      sentAt: m.sentAt,
      receivedAt,
      source: 'event' as const,
      msgType: 'text',
      text: m.text,
      rawContent,
      contentHash: contentHash(rawContent),
      atBot: false,
      recalledAt: m.recalledAt,
    };
  });
  const sorted = [...messages].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) throw new Error('放一段意图至少要有一条原话');
  return { chatId, chatKind: spec.chatKind ?? ('group' as const), messages, first, last };
}

export function seedMemory(store: MemoryIntentStore, now: () => Date): SeedFn {
  return async (spec) => {
    const f = filled(spec, now().toISOString());
    const seq = store.data.nextSeq++;
    const id = crypto.randomUUID();
    store.data.intents.push({
      id,
      seq,
      chatId: f.chatId,
      chatKind: f.chatKind,
      status: 'new',
      revision: 1,
      firstMessageId: f.first.messageId,
      firstMessageAt: f.first.sentAt,
      lastMessageAt: f.last.sentAt,
      links: [],
      card: { rev: 1, attempts: 0 },
    });
    for (const m of f.messages) {
      const row: IntentMessageRecord = { ...m, intentId: id, edits: [] };
      store.data.messages.push(row);
    }
    return seq;
  };
}

export function seedPg(db: Db, now: () => Date): SeedFn {
  return async (spec) => {
    const f = filled(spec, now().toISOString());
    const id = crypto.randomUUID();
    const [row] = await db
      .insert(intents)
      .values({
        id,
        chatId: f.chatId,
        chatKind: f.chatKind,
        status: 'new',
        firstMessageId: f.first.messageId,
        firstMessageAt: new Date(f.first.sentAt),
        lastMessageAt: new Date(f.last.sentAt),
        createdAt: now(),
        updatedAt: now(),
      })
      .returning({ seq: intents.seq });
    if (!row) throw new Error('放意图没写进去');
    await db.insert(intentMessages).values(
      f.messages.map((m) => ({
        ...m,
        intentId: id,
        sentAt: new Date(m.sentAt),
        receivedAt: new Date(m.receivedAt),
        recalledAt: m.recalledAt === undefined ? null : new Date(m.recalledAt),
      })),
    );
    return row.seq;
  };
}
