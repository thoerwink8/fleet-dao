// Postgres 版意图存储（#553 第 4 条）：和 intent-store.ts 的内存版过同一套契约测试。
// 改这里之前必须知道：
// - 判法只在 intents.ts：这里把要判的事实从库里找齐（同一会话的话题、回复的那条、前后最近的一条）、照结论写。
// - 同一个会话的原话按会话加事务锁（pg_advisory_xact_lock）一条一条归段：两条同时到不会各自另起一段。
// - links、edits 两个 jsonb 列读出来先按形状认一遍，认不出就抛（写明哪一段、哪一列），不当成空的。
// - 写回归纳、开成单、放下和操作记录在同一个事务里：记不下就不改。
// - 时刻：这里自己写的（收到时刻、卡的到期、写回时刻）一律用传进来的钟，和后端其余部分同一个钟。
import { auditLog, type Db, intentMessages, intentRecalls, intents } from '@fleet-dao/db';
import { isUuid } from '@fleet-dao/store';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  auditShape,
  type CardAckReport,
  type ChatCursor,
  type IntakeMessageResult,
  type IntentAudit,
  type IntentStore,
} from './intent-store.ts';
import {
  applyEdit,
  bumped,
  cardDueAt,
  contentHash,
  decideSegment,
  type IntentMessageRecord,
  type IntentRecord,
  type IntentWithMessages,
  insertOlderEdit,
  judgeRepeat,
  orderMessages,
  planAck,
  planDrop,
  planLink,
  type SegmentCandidate,
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

const candidate = (i: IntentRecord): SegmentCandidate => ({
  id: i.id,
  seq: i.seq,
  status: i.status,
  threadId: i.threadId,
});

export function createPgIntentStore(db: Db, options: { now?: () => Date } = {}): IntentStore {
  const now = options.now ?? (() => new Date());

  const lockChat = (tx: Db, chatId: string) =>
    tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`intent-chat:${chatId}`}))`);

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

  async function mustIntent(tx: Db, id: string, lock = false): Promise<IntentRecord> {
    const i = await oneIntent(tx, eq(intents.id, id), lock);
    if (!i) throw new Error(`意图 ${id} 读不到`);
    return i;
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

  /** 同一会话、不在话题里、紧挨着这个时刻前（含同一刻）或后的一条原话，和它所在的那段。 */
  async function neighbour(tx: Db, chatId: string, sentAt: Date, side: 'before' | 'after') {
    const rows = await tx
      .select({ sentAt: intentMessages.sentAt, intentId: intentMessages.intentId })
      .from(intentMessages)
      .where(
        and(
          eq(intentMessages.chatId, chatId),
          isNull(intentMessages.threadId),
          side === 'before' ? lte(intentMessages.sentAt, sentAt) : gt(intentMessages.sentAt, sentAt),
        ),
      )
      .orderBy(
        ...(side === 'before'
          ? [desc(intentMessages.sentAt), desc(intentMessages.messageId)]
          : [asc(intentMessages.sentAt), asc(intentMessages.messageId)]),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return { at: iso(row.sentAt), intent: candidate(await mustIntent(tx, row.intentId)) };
  }

  return {
    async intakeMessage(m) {
      const hash = contentHash(m.rawContent);
      return db.transaction(async (tx): Promise<IntakeMessageResult> => {
        await lockChat(tx, m.chatId);
        const [storedRow] = await tx
          .select()
          .from(intentMessages)
          .where(eq(intentMessages.messageId, m.messageId))
          .for('update');
        if (storedRow) {
          const stored = toMessage(storedRow);
          const intent = await mustIntent(tx, stored.intentId, true);
          const verdict = judgeRepeat(stored, {
            senderUserId: m.senderUserId,
            chatId: m.chatId,
            contentHash: hash,
            editedAt: m.editedAt,
          });
          if (verdict.kind === 'reused') return { status: 'reused', why: verdict.why };
          if (verdict.kind === 'replayed') {
            return { status: 'replayed', intentId: intent.id, intentSeq: intent.seq };
          }
          if (m.editedAt === undefined) throw new Error('判成了改过的一版，请求里却没有改动时刻');
          const incoming = {
            text: m.text,
            rawContent: m.rawContent,
            contentHash: hash,
            editedAt: m.editedAt,
            msgType: m.msgType,
          };
          const next =
            verdict.kind === 'edit' ? applyEdit(stored, incoming) : insertOlderEdit(stored, incoming);
          await tx
            .update(intentMessages)
            .set({
              msgType: next.msgType,
              text: next.text,
              rawContent: next.rawContent,
              contentHash: next.contentHash,
              editedAt: dateOpt(next.editedAt),
              edits: next.edits,
            })
            .where(eq(intentMessages.messageId, m.messageId));
          await writeIntent(tx, bumped(intent, now(), null));
          return { status: 'edited', intentId: intent.id, intentSeq: intent.seq };
        }

        const [tomb] = await tx
          .select({ recalledAt: intentRecalls.recalledAt })
          .from(intentRecalls)
          .where(eq(intentRecalls.messageId, m.messageId));
        const sentAt = date(m.sentAt);
        let thread: IntentRecord | undefined;
        if (m.threadId !== undefined) {
          const found = await intentsWhere(
            tx,
            and(eq(intents.chatId, m.chatId), eq(intents.threadId, m.threadId)),
          );
          thread = found[found.length - 1];
        }
        let parent: IntentRecord | undefined;
        if (m.parentId !== undefined) {
          const [pm] = await tx
            .select({ intentId: intentMessages.intentId })
            .from(intentMessages)
            .where(eq(intentMessages.messageId, m.parentId));
          parent = pm
            ? await mustIntent(tx, pm.intentId)
            : await oneIntent(tx, eq(intents.cardMessageId, m.parentId));
        }
        const decision = decideSegment({
          sentAt: m.sentAt,
          threadId: m.threadId,
          newSegment: m.newSegment,
          thread: thread && candidate(thread),
          parent: parent && candidate(parent),
          before: m.threadId === undefined ? await neighbour(tx, m.chatId, sentAt, 'before') : undefined,
          after: m.threadId === undefined ? await neighbour(tx, m.chatId, sentAt, 'after') : undefined,
        });

        let intentId: string;
        let intentSeq: number;
        if (decision.kind === 'join') {
          const intent = await mustIntent(tx, decision.intentId, true);
          const next = bumped(intent, now(), { urgent: m.atBot });
          if (decision.adoptThread !== undefined) next.threadId = decision.adoptThread;
          if (sentAt.getTime() < Date.parse(intent.firstMessageAt)) {
            next.firstMessageAt = m.sentAt;
            next.firstMessageId = m.messageId;
          }
          if (sentAt.getTime() > Date.parse(intent.lastMessageAt)) next.lastMessageAt = m.sentAt;
          await writeIntent(tx, next);
          intentId = intent.id;
          intentSeq = intent.seq;
        } else {
          intentId = crypto.randomUUID();
          const [row] = await tx
            .insert(intents)
            .values({
              id: intentId,
              chatId: m.chatId,
              chatKind: m.chatKind,
              threadId: decision.threadId ?? null,
              status: 'new',
              continuesIntentId: decision.continuesId ?? null,
              firstMessageId: m.messageId,
              firstMessageAt: sentAt,
              lastMessageAt: sentAt,
              cardDueAt: date(cardDueAt(m.chatKind, now(), m.atBot)),
              createdAt: now(),
              updatedAt: now(),
            })
            .returning({ seq: intents.seq });
          if (!row) throw new Error('新的一段意图没写进去');
          intentSeq = row.seq;
        }
        await tx.insert(intentMessages).values({
          messageId: m.messageId,
          intentId,
          chatId: m.chatId,
          threadId: m.threadId ?? null,
          parentId: m.parentId ?? null,
          senderUserId: m.senderUserId,
          senderName: m.senderName,
          sentAt,
          receivedAt: now(),
          source: m.source,
          msgType: m.msgType,
          text: m.text,
          rawContent: m.rawContent,
          contentHash: hash,
          atBot: m.atBot,
          forwardOf: m.forward?.of ?? null,
          forwardSender: m.forward?.senderName ?? null,
          editedAt: dateOpt(m.editedAt),
          recalledAt: tomb?.recalledAt ?? null,
        });
        return { status: tomb ? 'recalled' : 'stored', intentId, intentSeq, rule: decision.rule };
      });
    },

    async intakeRecall(r) {
      return db.transaction(async (tx) => {
        await lockChat(tx, r.chatId);
        const [stored] = await tx
          .select()
          .from(intentMessages)
          .where(eq(intentMessages.messageId, r.messageId))
          .for('update');
        const [tomb] = await tx.select().from(intentRecalls).where(eq(intentRecalls.messageId, r.messageId));
        if (stored && stored.chatId !== r.chatId) {
          return { status: 'reused', why: '要撤回的这条原话记在另一个会话里' } as const;
        }
        if (tomb && tomb.chatId !== r.chatId) {
          return { status: 'reused', why: '这个消息编号的撤回已经记在另一个会话里' } as const;
        }
        if (!tomb) {
          await tx.insert(intentRecalls).values({
            messageId: r.messageId,
            chatId: r.chatId,
            recalledAt: date(r.recalledAt),
            receivedAt: now(),
            source: r.source,
          });
        }
        if (!stored) return { status: 'tombstone' } as const;
        const intent = await mustIntent(tx, stored.intentId, true);
        if (stored.recalledAt !== null) return { status: 'already', intentSeq: intent.seq } as const;
        await tx
          .update(intentMessages)
          .set({ recalledAt: date(r.recalledAt) })
          .where(eq(intentMessages.messageId, r.messageId));
        await writeIntent(tx, bumped(intent, now(), { urgent: false }));
        return { status: 'recalled', intentSeq: intent.seq } as const;
      });
    },

    async cursors(chatId): Promise<ChatCursor[]> {
      const rows = await db
        .selectDistinctOn([intentMessages.chatId], {
          chatId: intentMessages.chatId,
          sentAt: intentMessages.sentAt,
          messageId: intentMessages.messageId,
          chatKind: intents.chatKind,
          messages: sql<number>`count(*) over (partition by ${intentMessages.chatId})`.mapWith(Number),
        })
        .from(intentMessages)
        .innerJoin(intents, eq(intents.id, intentMessages.intentId))
        .where(chatId === undefined ? undefined : eq(intentMessages.chatId, chatId))
        .orderBy(intentMessages.chatId, desc(intentMessages.sentAt), desc(intentMessages.messageId));
      return rows.map((r) => ({
        chatId: r.chatId,
        chatKind: r.chatKind,
        lastSentAt: iso(r.sentAt),
        lastMessageId: r.messageId,
        messages: r.messages,
      }));
    },

    async dueCards(limit) {
      const t = now();
      const pending = and(
        isNotNull(intents.cardDueAt),
        or(isNull(intents.cardShownRev), lt(intents.cardShownRev, intents.cardRev)),
        or(
          isNotNull(intents.cardMessageId),
          sql`exists (select 1 from intent_messages m where m.intent_id = ${sql.raw('"intents"."id"')} and m.recalled_at is null)`,
        ),
      );
      const due = await db
        .select({ row: intents, prevSeq: continuesSeq })
        .from(intents)
        .where(and(pending, lte(intents.cardDueAt, t)))
        .orderBy(asc(intents.cardDueAt), asc(intents.seq))
        .limit(limit);
      const [later] = await db
        .select({ dueAt: intents.cardDueAt })
        .from(intents)
        .where(and(pending, gt(intents.cardDueAt, t)))
        .orderBy(asc(intents.cardDueAt))
        .limit(1);
      return {
        items: await withMessages(
          db,
          due.map((r) => toIntent(r.row, r.prevSeq)),
        ),
        ...(later?.dueAt ? { nextDueAt: iso(later.dueAt) } : {}),
      };
    },

    async ackCards(acks) {
      return db.transaction(async (tx) => {
        const report: CardAckReport = { applied: 0, skipped: [] };
        for (const ack of acks) {
          const intent = isUuid(ack.intentId)
            ? await oneIntent(tx, eq(intents.id, ack.intentId), true)
            : undefined;
          if (!intent) {
            report.skipped.push({ intentId: ack.intentId, why: '没有这段意图' });
            continue;
          }
          const plan = planAck(intent, ack, now());
          if (plan.kind === 'skip') {
            report.skipped.push({ intentId: ack.intentId, why: plan.why });
            continue;
          }
          await writeIntent(tx, { ...intent, card: plan.card });
          report.applied += 1;
        }
        return report;
      });
    },

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
  };
}
