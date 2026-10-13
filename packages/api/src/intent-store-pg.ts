// Postgres 版意图存储（#553 第 4 条）：和 intent-store.ts 的内存版过同一套契约测试。
// 改这里之前必须知道：
// - 判法只在 intents.ts：这里把要判的事实从库里找齐、照结论写。
// - links、edits 两个 jsonb 列读出来先按形状认一遍，认不出就抛（写明哪一段、哪一列），不当成空的。
// - 写回归纳、开成单、放下和操作记录在同一个事务里：记不下就不改。
// - 时刻：这里自己写的（收到时刻、卡的到期、写回时刻）一律用传进来的钟，和后端其余部分同一个钟。
import {
  auditLog,
  type Db,
  feishuJoins,
  feishuUsageMonths,
  feishuUsageReports,
  intentMessages,
  intents,
} from '@fleet-dao/db';
import { beijingMonth } from '@fleet-dao/shared';
import { asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditShape, type IntentAudit, type IntentStore } from './intent-store.ts';
import {
  type IntentMessageRecord,
  type IntentRecord,
  type IntentWithMessages,
  orderMessages,
  planDrop,
  planLink,
} from './intents.ts';

type IntentRow = typeof intents.$inferSelect;
type MessageRow = typeof intentMessages.$inferSelect;

const iso = (d: Date) => d.toISOString();
const isoOpt = (d: Date | null) => (d ? d.toISOString() : undefined);
const opt = <V>(v: V | null): V | undefined => v ?? undefined;
const date = (s: string) => new Date(s);
const dateOpt = (s: string | undefined) => (s === undefined ? null : new Date(s));

const LinksShape = z.array(z.object({ issue: z.string().min(1), by: z.string(), at: z.string().min(1) }));
const EditsShape = z.array(
  z.object({
    text: z.string(),
    rawContent: z.string(),
    contentHash: z.string().min(1),
    replacedAt: z.string().min(1),
  }),
);

/**
 * 这段接着的那段是第几号（自连一次，不另存一份号）。外层的列要写全表名：drizzle 在只查一张表时不带表名，子查询里的
 * 同名列会被认成子查询自己那张。
 */
const continuesSeq = sql<number | null>`(select p.seq from intents p where p.id = ${sql.raw(
  '"intents"."continues_intent_id"',
)})`.mapWith((v: unknown) => (v === null ? null : Number(v)));

function toIntent(r: IntentRow, prevSeq: number | null): IntentRecord {
  const links = LinksShape.safeParse(r.links);
  if (!links.success) {
    throw new Error(`意图 ${r.seq} 的 links 认不出：${links.error.message.slice(0, 200)}`);
  }
  const summary =
    r.summaryText !== null && r.summaryBy !== null && r.summaryAt !== null && r.summaryCovers !== null
      ? { text: r.summaryText, by: r.summaryBy, at: iso(r.summaryAt), covers: r.summaryCovers }
      : undefined;
  const dropped =
    r.dropReason !== null && r.droppedBy !== null && r.droppedAt !== null
      ? { reason: r.dropReason, by: r.droppedBy, at: iso(r.droppedAt) }
      : undefined;
  return {
    id: r.id,
    seq: r.seq,
    chatId: r.chatId,
    chatKind: r.chatKind,
    threadId: opt(r.threadId),
    status: r.status,
    continuesSeq: opt(prevSeq),
    revision: r.revision,
    firstMessageId: r.firstMessageId,
    firstMessageAt: iso(r.firstMessageAt),
    lastMessageAt: iso(r.lastMessageAt),
    summary,
    links: links.data,
    dropped,
    card: {
      rev: r.cardRev,
      shownRev: opt(r.cardShownRev),
      messageId: opt(r.cardMessageId),
      dueAt: isoOpt(r.cardDueAt),
      attempts: r.cardAttempts,
      error: opt(r.cardError),
    },
  };
}

function toMessage(r: MessageRow): IntentMessageRecord {
  const edits = EditsShape.safeParse(r.edits);
  if (!edits.success) {
    throw new Error(`原话 ${r.messageId} 的 edits 认不出：${edits.error.message.slice(0, 200)}`);
  }
  return {
    messageId: r.messageId,
    intentId: r.intentId,
    chatId: r.chatId,
    threadId: opt(r.threadId),
    parentId: opt(r.parentId),
    senderUserId: r.senderUserId,
    senderName: r.senderName,
    sentAt: iso(r.sentAt),
    receivedAt: iso(r.receivedAt),
    source: r.source,
    msgType: r.msgType,
    text: r.text,
    rawContent: r.rawContent,
    contentHash: r.contentHash,
    atBot: r.atBot,
    forward:
      r.forwardOf === null
        ? undefined
        : { of: r.forwardOf, ...(r.forwardSender === null ? {} : { senderName: r.forwardSender }) },
    editedAt: isoOpt(r.editedAt),
    edits: edits.data,
    recalledAt: isoOpt(r.recalledAt),
  };
}

/** 一段的下一版写回库里：判法（intents.ts）算出来的那几样，原样落列。 */
function intentColumns(i: IntentRecord, now: Date) {
  return {
    threadId: i.threadId ?? null,
    status: i.status,
    revision: i.revision,
    firstMessageId: i.firstMessageId,
    firstMessageAt: date(i.firstMessageAt),
    lastMessageAt: date(i.lastMessageAt),
    summaryText: i.summary?.text ?? null,
    summaryBy: i.summary?.by ?? null,
    summaryAt: dateOpt(i.summary?.at),
    summaryCovers: i.summary?.covers ?? null,
    links: i.links,
    dropReason: i.dropped?.reason ?? null,
    droppedBy: i.dropped?.by ?? null,
    droppedAt: dateOpt(i.dropped?.at),
    cardRev: i.card.rev,
    cardShownRev: i.card.shownRev ?? null,
    cardMessageId: i.card.messageId ?? null,
    cardDueAt: dateOpt(i.card.dueAt),
    cardAttempts: i.card.attempts,
    cardError: i.card.error ?? null,
    updatedAt: now,
  };
}

export function createPgIntentStore(db: Db, options: { now?: () => Date } = {}): IntentStore {
  const now = options.now ?? (() => new Date());

  async function intentsWhere(tx: Db, where: SQL | undefined, lock = false) {
    const q = tx
      .select({ row: intents, prevSeq: continuesSeq })
      .from(intents)
      .where(where)
      .orderBy(asc(intents.seq));
    const rows = lock ? await q.for('update', { of: intents }) : await q;
    return rows.map((r) => toIntent(r.row, r.prevSeq));
  }

  async function oneIntent(tx: Db, where: SQL, lock = false): Promise<IntentRecord | undefined> {
    return (await intentsWhere(tx, where, lock))[0];
  }

  async function messagesOf(tx: Db, ids: readonly string[]): Promise<Map<string, IntentMessageRecord[]>> {
    const out = new Map<string, IntentMessageRecord[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return out;
    const rows = await tx
      .select()
      .from(intentMessages)
      .where(inArray(intentMessages.intentId, [...ids]))
      .orderBy(asc(intentMessages.sentAt), asc(intentMessages.messageId));
    for (const r of rows) out.get(r.intentId)?.push(toMessage(r));
    return out;
  }

  async function withMessages(tx: Db, list: readonly IntentRecord[]): Promise<IntentWithMessages[]> {
    const byIntent = await messagesOf(
      tx,
      list.map((i) => i.id),
    );
    return list.map((intent) => ({ intent, messages: orderMessages(byIntent.get(intent.id) ?? []) }));
  }

  async function writeIntent(tx: Db, next: IntentRecord): Promise<void> {
    const done = await tx
      .update(intents)
      .set(intentColumns(next, now()))
      .where(eq(intents.id, next.id))
      .returning({ id: intents.id });
    if (done.length !== 1) throw new Error(`意图 ${next.seq} 没写进去`);
  }

  async function writeAudit(
    tx: Db,
    audit: IntentAudit,
    fill: { before: unknown; after: unknown },
  ): Promise<void> {
    await tx.insert(auditLog).values({
      at: now(),
      actorKind: audit.actor.kind,
      actorId: audit.actor.id,
      action: audit.action,
      target: audit.target,
      before: fill.before,
      after: fill.after,
      reason: audit.reason ?? null,
      via: audit.via,
      ok: audit.ok,
      error: audit.error ?? null,
    });
  }

  return {
    async list(filter) {
      const rows = await db
        .select({ row: intents, prevSeq: continuesSeq })
        .from(intents)
        .where(filter.status === 'all' ? undefined : eq(intents.status, filter.status))
        .orderBy(asc(intents.seq))
        .limit(filter.limit);
      return withMessages(
        db,
        rows.map((r) => toIntent(r.row, r.prevSeq)),
      );
    },

    async get(seq) {
      if (!Number.isSafeInteger(seq) || seq < 1 || seq > 2_147_483_647) return null;
      const intent = await oneIntent(db, eq(intents.seq, seq));
      if (!intent) return null;
      const [one] = await withMessages(db, [intent]);
      return one ?? null;
    },

    async link(input, audit) {
      if (!Number.isSafeInteger(input.seq) || input.seq < 1 || input.seq > 2_147_483_647) {
        return { status: 'not_found' };
      }
      return db.transaction(async (tx) => {
        const intent = await oneIntent(tx, eq(intents.seq, input.seq), true);
        if (!intent) return { status: 'not_found' } as const;
        const messages = (await messagesOf(tx, [intent.id])).get(intent.id) ?? [];
        const plan = planLink(intent, messages, input, now());
        if (plan.status === 'empty' || plan.status === 'already_linked') return plan;
        await writeIntent(tx, plan.next);
        await writeAudit(tx, audit, { before: auditShape(intent), after: auditShape(plan.next) });
        return { status: plan.status, intent: { intent: plan.next, messages: orderMessages(messages) } };
      });
    },

    async drop(input, audit) {
      if (!Number.isSafeInteger(input.seq) || input.seq < 1 || input.seq > 2_147_483_647) {
        return { status: 'not_found' };
      }
      return db.transaction(async (tx) => {
        const intent = await oneIntent(tx, eq(intents.seq, input.seq), true);
        if (!intent) return { status: 'not_found' } as const;
        const plan = planDrop(intent, input, now());
        if (plan.status === 'linked') return plan;
        const messages = orderMessages((await messagesOf(tx, [intent.id])).get(intent.id) ?? []);
        if (plan.status === 'already') return { status: 'already', intent: { intent, messages } } as const;
        await writeIntent(tx, plan.next);
        await writeAudit(tx, audit, { before: auditShape(intent), after: auditShape(plan.next) });
        return { status: 'dropped', intent: { intent: plan.next, messages } } as const;
      });
    },

    async recordJoins(input) {
      const receivedAt = now();
      const at = date(input.at);
      await db.insert(feishuJoins).values(
        input.openIdTails.map((openIdTail) => ({
          chatId: input.chatId,
          openIdTail,
          at,
          reason: input.reason,
          receivedAt,
        })),
      );
      return input.openIdTails.length;
    },

    async addUsage(reportId, calls, at) {
      const month = beijingMonth(Date.parse(at));
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(feishuUsageReports)
          .values({ reportId, month, calls, appliedAt: now() })
          .onConflictDoNothing({ target: feishuUsageReports.reportId })
          .returning({ reportId: feishuUsageReports.reportId });
        const read = async (which: string) => {
          const [row] = await tx
            .select({ calls: feishuUsageMonths.calls })
            .from(feishuUsageMonths)
            .where(eq(feishuUsageMonths.month, which));
          return { month: which, calls: row?.calls ?? 0 };
        };
        if (inserted.length === 0) {
          const [known] = await tx
            .select({ month: feishuUsageReports.month })
            .from(feishuUsageReports)
            .where(eq(feishuUsageReports.reportId, reportId));
          return read(known?.month ?? month);
        }
        if (calls === 0) return read(month);
        const [row] = await tx
          .insert(feishuUsageMonths)
          .values({ month, calls })
          .onConflictDoUpdate({
            target: feishuUsageMonths.month,
            set: { calls: sql`${feishuUsageMonths.calls} + excluded.calls` },
          })
          .returning({ calls: feishuUsageMonths.calls });
        if (!row) throw new Error(`飞书用量 ${month} 写不进去`);
        return { month, calls: row.calls };
      });
    },

    async usageAt(at) {
      const month = beijingMonth(Date.parse(at));
      const [row] = await db
        .select({ calls: feishuUsageMonths.calls })
        .from(feishuUsageMonths)
        .where(eq(feishuUsageMonths.month, month));
      return { month, calls: row?.calls ?? 0 };
    },
  };
}
