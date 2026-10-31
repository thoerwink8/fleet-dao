// 会话事件流的读写：一个会话一条流 `session:<号>`。读都有页上限，行数和页大小成正比。
import { type NewEvent, SCHEMA_VERSION, type StoredEvent } from '@fleet-dao/harness-contract';
import { appendEvents, type Db, events, PAGE_MAX, StreamConflictError } from '@fleet-dao/harness-store';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';

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
  return appendToStream(db, sessionStream(sessionId), type, payload);
}

/** 往任意一条流追加一条（同上，撞上重试）。开发后端和 e2e 用它造工人过程流（transcript:<runId>）的样例。 */
export async function appendToStream(
  db: Db,
  streamId: string,
  type: NewEvent['type'],
  payload: Record<string, unknown>,
): Promise<StoredEvent> {
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
export function readSessionAfter(
  db: Db,
  sessionId: string,
  afterId: number,
  limit = 100,
): Promise<StoredEvent[]> {
  return readStreamAfterId(db, sessionStream(sessionId), afterId, limit);
}

/** 这条流 afterId 之后的事件（按全局事件号），最多 limit 条（不超过 PAGE_MAX）。会话流和工人过程流（transcript:<runId>）共用。 */
export async function readStreamAfterId(
  db: Db,
  streamId: string,
  afterId: number,
  limit = 100,
): Promise<StoredEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.streamId, streamId), gt(events.id, afterId)))
    .orderBy(asc(events.id))
    .limit(Math.min(limit, PAGE_MAX));
  return rows.map(toStored);
}

export interface HistoryPage {
  events: StoredEvent[];
  /** 这个会话现在最新一条的事件号（没有事件是 0）：页面拿它当 SSE 的 Last-Event-ID 起点。 */
  head: number;
  /** 按读的方向还有没有没读到的（tail/before 看更老的，after 看更新的）。 */
  hasMore: boolean;
}

/**
 * 会话事件的历史页（驾驶舱首屏和 resync 整页重取用），行数和 limit 成正比（不超过 PAGE_MAX）：
 * 不给游标 = 最新的 limit 条；before = 这个事件号之前最近的 limit 条；after = 这个事件号之后最早的 limit 条。
 * 都按事件号升序返回。
 *
 * maxBytes（给了才生效，参考 T3 Code 历史页「行数和字节数两道上限」的做法）：载荷序列化后的字节累计超过它就少给几条，
 * 至少给一条；少给的那部分算「还有没读到的」（hasMore）。读的行数仍是 limit+1，和 limit 成正比。
 * 往更老翻（before / 不给游标）时留最新的、舍最老的；往更新翻（after）时留最早的、舍最新的，游标接得上、不跳。
 */
export async function readStreamHistory(
  db: Db,
  streamId: string,
  opts: { before?: number; after?: number; limit?: number; maxBytes?: number } = {},
): Promise<HistoryPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, PAGE_MAX));
  const stream = eq(events.streamId, streamId);
  const head = await latestStreamEventId(db, streamId);
  if (opts.after !== undefined) {
    const rows = await db
      .select()
      .from(events)
      .where(and(stream, gt(events.id, opts.after)))
      .orderBy(asc(events.id))
      .limit(limit + 1);
    const page = fitBytes(rows.slice(0, limit), opts.maxBytes);
    return {
      events: page.map(toStored),
      head,
      hasMore: rows.length > limit || page.length < Math.min(rows.length, limit),
    };
  }
  const where = opts.before !== undefined ? and(stream, lt(events.id, opts.before)) : stream;
  const rows = await db
    .select()
    .from(events)
    .where(where)
    .orderBy(desc(events.id))
    .limit(limit + 1);
  const page = fitBytes(rows.slice(0, limit), opts.maxBytes);
  return {
    events: page.reverse().map(toStored),
    head,
    hasMore: rows.length > limit || page.length < Math.min(rows.length, limit),
  };
}

/** 按载荷字节预算取前缀（rows 已按读的方向排好），至少留一条。 */
function fitBytes<T extends { payload: unknown }>(rows: T[], maxBytes: number | undefined): T[] {
  if (maxBytes === undefined) return rows;
  let total = 0;
  const kept: T[] = [];
  for (const r of rows) {
    total += Buffer.byteLength(JSON.stringify(r.payload), 'utf8');
    if (kept.length > 0 && total > maxBytes) break;
    kept.push(r);
  }
  return kept;
}

/** afterId 之后这条流有没有超过 cap 条：最多读 cap+1 行，不数全表。 */
export async function streamGapExceeds(
  db: Db,
  streamId: string,
  afterId: number,
  cap: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.streamId, streamId), gt(events.id, afterId)))
    .orderBy(asc(events.id))
    .limit(cap + 1);
  return rows.length > cap;
}

/** 这条流最新一条的事件号，没有事件返回 0。 */
export async function latestStreamEventId(db: Db, streamId: string): Promise<number> {
  const [row] = await db
    .select({ id: sql<number>`coalesce(max(${events.id}), 0)::int` })
    .from(events)
    .where(eq(events.streamId, streamId));
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
