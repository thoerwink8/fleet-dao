// 会话事件流的读写：一个会话一条流 `session:<号>`。读都有页上限，行数和页大小成正比。
import { type NewEvent, SCHEMA_VERSION, type StoredEvent } from '@fleet-dao/harness-contract';
import { appendEvents, type Db, events, PAGE_MAX, StreamConflictError } from '@fleet-dao/harness-store';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

export const sessionStream = (sessionId: string): string => `session:${sessionId}`;

async function headSeq(db: Db, streamId: string): Promise<number> {
  const [row] = await db
    .select({ seq: sql<number>`coalesce(max(${events.seq}), 0)::int` })
    .from(events)
    .where(eq(events.streamId, streamId));
  return row?.seq ?? 0;
}

/** 往会话流追加一条：并发撞上就重读位置再试，最多 5 次。 */
export async function appendToSession(
  db: Db,
  sessionId: string,
  type: NewEvent['type'],
  payload: Record<string, unknown>,
): Promise<StoredEvent> {
  const streamId = sessionStream(sessionId);
  for (let attempt = 0; ; attempt++) {
    try {
      const [stored] = await appendEvents(db, streamId, await headSeq(db, streamId), [
        { schemaVersion: SCHEMA_VERSION, type, payload },
      ]);
      if (!stored) throw new Error('追加没有返回事件');
      return stored;
    } catch (err) {
      if (!(err instanceof StreamConflictError) || attempt >= 4) throw err;
    }
  }
}

function toStored(r: typeof events.$inferSelect): StoredEvent {
  return {
    id: r.id,
    streamId: r.streamId,
    seq: r.seq,
    type: r.type as StoredEvent['type'],
    schemaVersion: SCHEMA_VERSION,
    payload: r.payload as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  } as StoredEvent;
}

/** 这个会话 afterId 之后的事件（按全局事件号），最多 limit 条（不超过 PAGE_MAX）。 */
export async function readSessionAfter(
  db: Db,
  sessionId: string,
  afterId: number,
  limit = 100,
): Promise<StoredEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.streamId, sessionStream(sessionId)), gt(events.id, afterId)))
    .orderBy(asc(events.id))
    .limit(Math.min(limit, PAGE_MAX));
  return rows.map(toStored);
}

/** afterId 之后这个会话有没有超过 cap 条：最多读 cap+1 行，不数全表。 */
export async function gapExceeds(db: Db, sessionId: string, afterId: number, cap: number): Promise<boolean> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.streamId, sessionStream(sessionId)), gt(events.id, afterId)))
    .orderBy(asc(events.id))
    .limit(cap + 1);
  return rows.length > cap;
}

/** 这个会话最新一条的事件号，没有事件返回 0。 */
export async function latestSessionEventId(db: Db, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ id: sql<number>`coalesce(max(${events.id}), 0)::int` })
    .from(events)
    .where(eq(events.streamId, sessionStream(sessionId)));
  return row?.id ?? 0;
}

/** 这个会话流里某类事件，按 seq 往后一页（游标 afterSeq）。 */
export async function readSessionByType(
  db: Db,
  sessionId: string,
  type: NewEvent['type'],
  afterSeq: number,
  limit = PAGE_MAX,
): Promise<StoredEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(
      and(eq(events.streamId, sessionStream(sessionId)), eq(events.type, type), gt(events.seq, afterSeq)),
    )
    .orderBy(asc(events.seq))
    .limit(Math.min(limit, PAGE_MAX));
  return rows.map(toStored);
}

/** 这个会话流里 payload.taskId 等于给定值的事件。 */
export async function readSessionByTask(db: Db, sessionId: string, taskId: string): Promise<StoredEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.streamId, sessionStream(sessionId)), sql`${events.payload}->>'taskId' = ${taskId}`))
    .orderBy(asc(events.seq))
    .limit(PAGE_MAX);
  return rows.map(toStored);
}
