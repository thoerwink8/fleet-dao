// 新内核的存储读写口（决定 0124，#3773）：事件追加和读、投影重建、命令回执、outbox 领取和收尾。
// 三条硬规矩：对外副作用只经 outbox；结果不知道记 unknown 不盲重试；令牌对不上的外部动作丢进 dead，不做。
import { randomUUID } from 'node:crypto';
import type { NewEvent, OutboxKind, StoredEvent, TaskRef } from '@fleet-dao/harness-contract';
import {
  DEADLINE_GRACE_MS,
  deriveWorkerState,
  pushTail,
  type TailEvent,
  tailEventFrom,
  trackedDeadlineMs,
  type WorkerState,
} from '@fleet-dao/harness-contract/worker-state';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.ts';

const {
  events,
  commandReceipts,
  outbox,
  projectionCheckpoints,
  sessionWorkerState,
  streamHeads,
  workerStateCounts,
  workerStateMeta,
} = schema;

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** 追加时这条流已经不在调用方以为的位置（别人先写了）：调用方重读再决定，不覆盖。 */
export class StreamConflictError extends Error {
  constructor(streamId: string, expected: number, actual: number) {
    super(`流 ${streamId} 现在走到第 ${actual} 条，调用方以为是第 ${expected} 条：别人先写了，重读再决定`);
    this.name = 'StreamConflictError';
  }
}

/** 一页最多读多少条：读的行数和页大小成正比，不和表大小成正比。 */
export const PAGE_MAX = 500;

/**
 * 往一条流追加：expectedSeq 是调用方读到的这条流最后一条的 seq（新流给 0）。
 * 对不上抛 StreamConflictError；两个写者同时追加时 (stream_id, seq) 唯一挡住后到的那个。
 */
export async function appendEvents(
  db: Db,
  streamId: string,
  expectedSeq: number,
  batch: readonly NewEvent[],
): Promise<StoredEvent[]> {
  if (batch.length === 0) return [];
  return db.transaction(async (tx) => {
    const [head] = await tx
      .select({ seq: sql<number>`coalesce(max(${events.seq}), 0)::int` })
      .from(events)
      .where(eq(events.streamId, streamId));
    const actual = head?.seq ?? 0;
    if (actual !== expectedSeq) throw new StreamConflictError(streamId, expectedSeq, actual);
    try {
      const rows = await tx
        .insert(events)
        .values(
          batch.map((e, i) => ({
            streamId,
            seq: expectedSeq + i + 1,
            type: e.type,
            schemaVersion: e.schemaVersion,
            payload: e.payload,
          })),
        )
        .returning();
      return rows.map(toStored);
    } catch (err) {
      if (isUniqueViolation(err)) throw new StreamConflictError(streamId, expectedSeq, expectedSeq + 1);
      throw err;
    }
  });
}

/** 读一条流 afterSeq 之后的事件，按 seq，最多 limit 条。 */
export async function readStream(
  db: Db,
  streamId: string,
  afterSeq: number,
  limit = 100,
): Promise<StoredEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.streamId, streamId), gt(events.seq, afterSeq)))
    .orderBy(asc(events.seq))
    .limit(Math.min(limit, PAGE_MAX));
  return rows.map(toStored);
}

/** 按全局编号往后读（投影、广播用），最多 limit 条。 */
export async function readAfter(db: Db, afterId: number, limit = 100): Promise<StoredEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(gt(events.id, afterId))
    .orderBy(asc(events.id))
    .limit(Math.min(limit, PAGE_MAX));
  return rows.map(toStored);
}

const STREAM_HEADS = 'stream_heads';

/**
 * 把 stream_heads 投影往前推：从检查点往后一页一页读，同一个事务里改投影和检查点，中途崩了下次从检查点接着走。
 * 回推进了几条。
 */
export async function advanceStreamHeads(db: Db, pageSize = 200): Promise<number> {
  let total = 0;
  for (;;) {
    const moved = await db.transaction(async (tx) => {
      const [cp] = await tx
        .select({ last: projectionCheckpoints.lastEventId })
        .from(projectionCheckpoints)
        .where(eq(projectionCheckpoints.name, STREAM_HEADS))
        .for('update');
      const after = cp?.last ?? 0;
      const page = await tx
        .select()
        .from(events)
        .where(gt(events.id, after))
        .orderBy(asc(events.id))
        .limit(Math.min(pageSize, PAGE_MAX));
      if (page.length === 0) return 0;
      for (const e of page) {
        await tx
          .insert(streamHeads)
          .values({
            streamId: e.streamId,
            headSeq: e.seq,
            lastType: e.type,
            events: 1,
            lastEventId: e.id,
            lastAt: e.createdAt,
          })
          .onConflictDoUpdate({
            target: streamHeads.streamId,
            set: {
              headSeq: sql`greatest(${streamHeads.headSeq}, ${e.seq})`,
              lastType: sql`case when ${e.seq} >= ${streamHeads.headSeq} then ${e.type} else ${streamHeads.lastType} end`,
              events: sql`${streamHeads.events} + 1`,
              lastEventId: sql`greatest(${streamHeads.lastEventId}, ${e.id})`,
              lastAt: sql`case when ${e.id} >= ${streamHeads.lastEventId} then ${e.createdAt.toISOString()}::timestamptz else ${streamHeads.lastAt} end`,
            },
          });
      }
      const last = page.at(-1)?.id ?? after;
      await tx
        .insert(projectionCheckpoints)
        .values({ name: STREAM_HEADS, lastEventId: last })
        .onConflictDoUpdate({
          target: projectionCheckpoints.name,
          set: { lastEventId: last, updatedAt: new Date() },
        });
      return page.length;
    });
    total += moved;
    if (moved === 0) return total;
  }
}

/** 删掉 stream_heads 投影和它的检查点（重建前用）。只动投影，不碰事件。 */
export async function resetStreamHeads(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(streamHeads);
    await tx.delete(projectionCheckpoints).where(eq(projectionCheckpoints.name, STREAM_HEADS));
  });
}

const SESSION_WORKER_STATE = 'session_worker_state';
const WORKER_STATES = ['done', 'running', 'stuck', 'waiting'] as const satisfies readonly WorkerState[];

/**
 * 卡住个数只读这一句：状态计数表里 stuck 那一行。
 * 四种状态各一行，整表扫到也只有四行，不随会话数涨。测试拿这句去看执行计划。
 */
export const STUCK_COUNT_READ_SQL =
  "select n::int as n from fleet2.worker_state_counts where state = 'stuck'";

/** 计数前先看最早的截止时间（一行）。还没到宽限就不用去碰会话表。 */
export const STUCK_COUNT_META_SQL = 'select next_deadline from fleet2.worker_state_meta where id = 1';

/** 上面那句计数最多碰这么多行（四种状态各一行）。 */
export const STUCK_COUNT_ROW_BOUND = WORKER_STATES.length;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return rows ?? [];
}

function asTail(v: unknown): TailEvent[] {
  const parsed = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(parsed) ? (parsed as TailEvent[]) : [];
}

function asMillis(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

async function ensureWorkerStateRows(tx: Db): Promise<void> {
  await tx
    .insert(workerStateCounts)
    .values(WORKER_STATES.map((state) => ({ state, n: 0 })))
    .onConflictDoNothing();
  await tx.insert(workerStateMeta).values({ id: 1 }).onConflictDoNothing();
}

async function lockWorkerState(tx: Db): Promise<void> {
  await tx.execute(
    sql`select ${workerStateCounts.state} from ${workerStateCounts} order by ${workerStateCounts.state} for update`,
  );
  await tx.execute(
    sql`select ${workerStateMeta.id} from ${workerStateMeta} where ${workerStateMeta.id} = 1 for update`,
  );
}

/** 还在跑的会话里最早的截止时间，写回那一行。只在推进投影或真有会话到点时调用。 */
async function refreshNextDeadline(tx: Db): Promise<void> {
  await tx.execute(sql`
    update ${workerStateMeta}
    set next_deadline = (
      select min(${sessionWorkerState.deadline}) from ${sessionWorkerState}
      where ${sessionWorkerState.state} = 'running' and ${sessionWorkerState.deadline} is not null
    )
    where ${workerStateMeta.id} = 1
  `);
}

/** 截止时间加宽限已经过了的，从在跑改成卡住。回改了几行（只碰这些行，不扫没记截止时间的会话）。 */
async function expireRunning(tx: Db, now: number): Promise<number> {
  const cutoff = new Date(now - DEADLINE_GRACE_MS).toISOString();
  const result = await tx.execute(sql`
    update ${sessionWorkerState}
    set state = 'stuck', deadline = null
    where ${sessionWorkerState.state} = 'running'
      and ${sessionWorkerState.deadline} is not null
      and ${sessionWorkerState.deadline} < ${cutoff}::timestamptz
    returning ${sessionWorkerState.streamId}
  `);
  return rowsOf(result).length;
}

/**
 * 把会话工人状态投影往前推：从检查点往后一页一页读，同一个事务里改投影、计数和检查点。
 * 只折 `session:` 流；窗口和判法是 harness-contract 的 deriveWorkerState。回推进了几条事件。
 */
export async function advanceSessionWorkerState(db: Db, now = Date.now(), pageSize = 200): Promise<number> {
  let total = 0;
  for (;;) {
    const moved = await db.transaction(async (tx) => {
      const w = tx as unknown as Db;
      await ensureWorkerStateRows(w);
      await lockWorkerState(w);
      const [cp] = await w
        .select({ last: projectionCheckpoints.lastEventId })
        .from(projectionCheckpoints)
        .where(eq(projectionCheckpoints.name, SESSION_WORKER_STATE))
        .for('update');
      const after = cp?.last ?? 0;
      const page = await w
        .select()
        .from(events)
        .where(gt(events.id, after))
        .orderBy(asc(events.id))
        .limit(Math.min(pageSize, PAGE_MAX));
      if (page.length === 0) return 0;
      const sessionIds = [
        ...new Set(page.filter((e) => e.streamId.startsWith('session:')).map((e) => e.streamId)),
      ];
      const had = new Map<string, { state: WorkerState; tail: TailEvent[] }>();
      if (sessionIds.length > 0) {
        const existing = await w
          .select({
            streamId: sessionWorkerState.streamId,
            state: sessionWorkerState.state,
            tail: sessionWorkerState.tail,
          })
          .from(sessionWorkerState)
          .where(inArray(sessionWorkerState.streamId, sessionIds));
        for (const row of existing)
          had.set(row.streamId, { state: row.state as WorkerState, tail: asTail(row.tail) });
      }
      const dirty = new Map<
        string,
        {
          prev: WorkerState | null;
          state: WorkerState;
          tail: TailEvent[];
          deadlineMs: number | null;
          headSeq: number;
          lastEventId: number;
        }
      >();
      for (const e of page) {
        if (!e.streamId.startsWith('session:')) continue;
        let cur = dirty.get(e.streamId);
        if (!cur) {
          const prev = had.get(e.streamId);
          cur = {
            prev: prev?.state ?? null,
            state: prev?.state ?? 'waiting',
            tail: prev?.tail ?? [],
            deadlineMs: null,
            headSeq: 0,
            lastEventId: 0,
          };
          dirty.set(e.streamId, cur);
        }
        cur.tail = pushTail(cur.tail, tailEventFrom(e.type, e.payload));
        cur.state = deriveWorkerState(cur.tail, now);
        cur.deadlineMs = trackedDeadlineMs(cur.tail, now);
        cur.headSeq = e.seq;
        cur.lastEventId = e.id;
      }
      if (dirty.size > 0) {
        await w
          .insert(sessionWorkerState)
          .values(
            [...dirty.entries()].map(([streamId, cur]) => ({
              streamId,
              state: cur.state,
              deadline: cur.deadlineMs === null ? null : new Date(cur.deadlineMs),
              tail: cur.tail,
              headSeq: cur.headSeq,
              lastEventId: cur.lastEventId,
            })),
          )
          .onConflictDoUpdate({
            target: sessionWorkerState.streamId,
            set: {
              state: sql`excluded.state`,
              deadline: sql`excluded.deadline`,
              tail: sql`excluded.tail`,
              headSeq: sql`excluded.head_seq`,
              lastEventId: sql`excluded.last_event_id`,
            },
          });
        const delta = new Map<WorkerState, number>();
        const add = (state: WorkerState, d: number) => delta.set(state, (delta.get(state) ?? 0) + d);
        for (const cur of dirty.values()) {
          if (cur.prev === cur.state) continue;
          if (cur.prev) add(cur.prev, -1);
          add(cur.state, 1);
        }
        for (const [state, d] of delta) {
          if (d === 0) continue;
          await w
            .update(workerStateCounts)
            .set({ n: sql`${workerStateCounts.n} + ${d}` })
            .where(eq(workerStateCounts.state, state));
        }
      }
      await refreshNextDeadline(w);
      const last = page.at(-1)?.id ?? after;
      await w
        .insert(projectionCheckpoints)
        .values({ name: SESSION_WORKER_STATE, lastEventId: last })
        .onConflictDoUpdate({
          target: projectionCheckpoints.name,
          set: { lastEventId: last, updatedAt: new Date() },
        });
      return page.length;
    });
    total += moved;
    if (moved === 0) return total;
  }
}

/** 删掉会话工人状态投影、计数和检查点（重建前用）。只动投影，不碰事件。 */
export async function resetSessionWorkerState(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(sessionWorkerState);
    await tx.delete(workerStateCounts);
    await tx.delete(workerStateMeta);
    await tx.delete(projectionCheckpoints).where(eq(projectionCheckpoints.name, SESSION_WORKER_STATE));
  });
}

/**
 * 全库卡住的会话数。平时只读计数表的一行；最早的截止时间还没过宽限，就不碰会话表。
 * 到点了才把那些已经过了宽限的在跑会话改判卡住，并改同一份计数。
 */
export async function countProjectedStuck(db: Db, now: number): Promise<number> {
  return db.transaction(async (tx) => {
    const w = tx as unknown as Db;
    await ensureWorkerStateRows(w);
    await lockWorkerState(w);
    const meta = rowsOf<{ next_deadline: Date | string | null }>(
      await w.execute(sql.raw(STUCK_COUNT_META_SQL)),
    )[0];
    const nextMs = asMillis(meta?.next_deadline ?? null);
    if (nextMs !== null && nextMs + DEADLINE_GRACE_MS < now) {
      const flipped = await expireRunning(w, now);
      if (flipped > 0) {
        await w
          .update(workerStateCounts)
          .set({ n: sql`${workerStateCounts.n} + ${flipped}` })
          .where(eq(workerStateCounts.state, 'stuck'));
        await w
          .update(workerStateCounts)
          .set({ n: sql`${workerStateCounts.n} - ${flipped}` })
          .where(eq(workerStateCounts.state, 'running'));
        await refreshNextDeadline(w);
      }
    }
    const result = await w.execute(sql.raw(STUCK_COUNT_READ_SQL));
    const raw = rowsOf<{ n: number | string }>(result)[0]?.n ?? 0;
    return typeof raw === 'number' ? raw : Number(raw);
  });
}

/** 同键异命令：调用方用错了键，拒。 */
export class ReceiptConflictError extends Error {
  constructor(key: string, had: string, got: string) {
    super(`幂等键 ${key} 已用于「${had}」，这次是「${got}」：同一个键不能给两件事用`);
    this.name = 'ReceiptConflictError';
  }
}

/**
 * 同一个幂等键只做一次：第一次跑 run 并记回执，之后回原结果、不再跑。
 * run 和记回执在同一个事务里；run 里不许有外部副作用（外部动作走 outbox）。
 */
export async function onceByReceipt<T>(
  db: Db,
  key: string,
  command: string,
  run: (tx: Db) => Promise<T>,
): Promise<{ replayed: boolean; result: T }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(commandReceipts)
      .values({ key, command, result: {} })
      .onConflictDoNothing()
      .returning({ key: commandReceipts.key });
    if (inserted.length === 0) {
      const [had] = await tx.select().from(commandReceipts).where(eq(commandReceipts.key, key));
      if (!had) throw new Error(`幂等键 ${key} 冲突却读不到原回执`);
      if (had.command !== command) throw new ReceiptConflictError(key, had.command, command);
      return { replayed: true, result: had.result as T };
    }
    const result = await run(tx as unknown as Db);
    await tx
      .update(commandReceipts)
      .set({ result: result as unknown as Record<string, unknown> })
      .where(eq(commandReceipts.key, key));
    return { replayed: false, result };
  });
}

export interface OutboxOp {
  id: number;
  opKey: string;
  kind: OutboxKind;
  ref: TaskRef;
  fencing: number;
  payload: Record<string, unknown>;
  state: 'pending' | 'claimed' | 'done' | 'unknown' | 'dead';
  attempts: number;
  claimToken: string | null;
}

/** 预留一件外部动作：同一个操作键只进一次，再来回已有那条（不管它现在什么状态）。 */
export async function enqueueOp(
  db: Db,
  op: { opKey: string; kind: OutboxKind; ref: TaskRef; fencing: number; payload: Record<string, unknown> },
): Promise<{ created: boolean; op: OutboxOp }> {
  const inserted = await db
    .insert(outbox)
    .values({
      opKey: op.opKey,
      kind: op.kind,
      repo: op.ref.repo,
      issue: op.ref.issue,
      fencing: op.fencing,
      payload: op.payload,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { created: true, op: toOp(inserted[0]) };
  const [had] = await db.select().from(outbox).where(eq(outbox.opKey, op.opKey));
  if (!had) throw new Error(`操作键 ${op.opKey} 冲突却读不到原来那条`);
  return { created: false, op: toOp(had) };
}

/**
 * 领到期的外部动作：pending 和 unknown（unknown 领到的人必须先查证、不能直接再做）、以及租约过期的 claimed。
 * FOR UPDATE SKIP LOCKED，两个领取者不会领到同一条；时刻按数据库的 now() 判。
 */
export async function claimDueOps(db: Db, limit: number, leaseMs: number): Promise<OutboxOp[]> {
  const token = randomUUID();
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        sql`(${outbox.state} in ('pending', 'unknown') and ${outbox.nextAt} <= now())
          or (${outbox.state} = 'claimed' and ${outbox.leaseUntil} < now())`,
      )
      .orderBy(asc(outbox.nextAt), asc(outbox.id))
      .limit(Math.min(limit, PAGE_MAX))
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    const rows = await tx
      .update(outbox)
      .set({
        state: 'claimed',
        claimToken: token,
        leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        attempts: sql`${outbox.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        inArray(
          outbox.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
    return rows.map(toOp);
  });
}

/** 收尾时这条已经不归你了（租约过了被别人领走）：什么都不改。 */
export class LostClaimError extends Error {
  constructor(id: number) {
    super(`外部动作 ${id} 已经不归这次领取了（租约过了被别人领走），结果不写`);
    this.name = 'LostClaimError';
  }
}

async function settle(
  db: Db,
  op: Pick<OutboxOp, 'id' | 'claimToken'>,
  set: Partial<typeof outbox.$inferInsert>,
): Promise<void> {
  if (!op.claimToken) throw new LostClaimError(op.id);
  const rows = await db
    .update(outbox)
    .set({ ...set, leaseUntil: null, claimToken: null, updatedAt: sql`now()` })
    .where(and(eq(outbox.id, op.id), eq(outbox.state, 'claimed'), eq(outbox.claimToken, op.claimToken)))
    .returning({ id: outbox.id });
  if (rows.length === 0) throw new LostClaimError(op.id);
}

/**
 * 领到了但这次不归这条路做（例如本机只处理 forge=local）：退回 pending，尝试次数还回去。
 * 不记错，下次该谁领还谁领。
 */
export function releaseOp(db: Db, op: OutboxOp): Promise<void> {
  return settle(db, op, {
    state: 'pending',
    attempts: sql`${outbox.attempts} - 1` as unknown as number,
    nextAt: sql`now()` as unknown as Date,
    lastError: null,
  });
}

/** 做成并查证过。 */
export function completeOp(db: Db, op: OutboxOp, result: Record<string, unknown>): Promise<void> {
  return settle(db, op, { state: 'done', result, lastError: null });
}

/** 发出去了、结果不知道（超时、断线）：记 unknown，到点再领时先查证。 */
export function markUnknown(db: Db, op: OutboxOp, why: string, retryInMs: number): Promise<void> {
  return settle(db, op, {
    state: 'unknown',
    lastError: why,
    nextAt: sql`now() + make_interval(secs => ${retryInMs / 1000})` as unknown as Date,
  });
}

/** 确定没做成：退避后再试；到了上限进 dead 等人。 */
export function failOp(
  db: Db,
  op: OutboxOp,
  why: string,
  retryInMs: number,
  maxAttempts: number,
): Promise<void> {
  if (op.attempts >= maxAttempts)
    return settle(db, op, { state: 'dead', lastError: `重试 ${op.attempts} 次到顶：${why}` });
  return settle(db, op, {
    state: 'pending',
    lastError: why,
    nextAt: sql`now() + make_interval(secs => ${retryInMs / 1000})` as unknown as Date,
  });
}

/**
 * 执行前核令牌：这件动作预留时带的令牌和这张单现在的令牌不一样，说明已经易手，丢进 dead，不做。
 * currentFencing 由调用方给（读旧库 tasks.fencing），读不到抛错，不当成对得上。回能不能做。
 */
export async function checkFencing(
  db: Db,
  op: OutboxOp,
  currentFencing: (ref: TaskRef) => Promise<number>,
): Promise<boolean> {
  const now = await currentFencing(op.ref);
  if (now === op.fencing) return true;
  await settle(db, op, {
    state: 'dead',
    lastError: `令牌对不上：预留时 ${op.fencing}，现在 ${now}，这张单已经易手，不做`,
  });
  return false;
}

/** 一张单名下的外部动作（切回、状态页用），按预留先后，最多 limit 条。 */
export async function listOpsForTask(db: Db, ref: TaskRef, limit = 50): Promise<OutboxOp[]> {
  const rows = await db
    .select()
    .from(outbox)
    .where(and(eq(outbox.repo, ref.repo), eq(outbox.issue, ref.issue)))
    .orderBy(asc(outbox.id))
    .limit(Math.min(limit, PAGE_MAX));
  return rows.map(toOp);
}

/** 按操作键读一条。 */
export async function getOp(db: Db, key: string): Promise<(OutboxOp & { result: unknown }) | null> {
  const [row] = await db.select().from(outbox).where(eq(outbox.opKey, key));
  return row ? { ...toOp(row), result: row.result } : null;
}

/**
 * 切回用：这张单还没开始做的（pending）外部动作一律作废进 dead。claimed / unknown 不动：
 * 有人正在做、或发出去了结果不知道，只能等它们收尾、对账，不在半路转手。回作废了几条。
 */
export async function cancelPendingOps(db: Db, ref: TaskRef, why: string): Promise<number> {
  const rows = await db
    .update(outbox)
    .set({ state: 'dead', lastError: why, updatedAt: sql`now()` })
    .where(and(eq(outbox.repo, ref.repo), eq(outbox.issue, ref.issue), eq(outbox.state, 'pending')))
    .returning({ id: outbox.id });
  return rows.length;
}

/** 积压：到期没做的最老一条多大了（秒），健康检查看调度有没有往前走。没有积压回 0。 */
export async function oldestDueAgeSeconds(db: Db): Promise<number> {
  const [row] = await db
    .select({ age: sql<number>`coalesce(extract(epoch from now() - min(${outbox.nextAt})), 0)::float8` })
    .from(outbox)
    .where(and(inArray(outbox.state, ['pending', 'unknown']), lte(outbox.nextAt, sql`now()`)));
  return Math.max(0, Number(row?.age ?? 0));
}

function toStored(r: typeof events.$inferSelect): StoredEvent {
  return {
    id: r.id,
    streamId: r.streamId,
    seq: r.seq,
    type: r.type as StoredEvent['type'],
    schemaVersion: r.schemaVersion as StoredEvent['schemaVersion'],
    payload: r.payload as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  };
}

function toOp(r: typeof outbox.$inferSelect): OutboxOp {
  return {
    id: r.id,
    opKey: r.opKey,
    kind: r.kind as OutboxKind,
    ref: { repo: r.repo, issue: r.issue },
    fencing: r.fencing,
    payload: r.payload as Record<string, unknown>,
    state: r.state as OutboxOp['state'],
    attempts: r.attempts,
    claimToken: r.claimToken,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: unknown; cause?: { code?: unknown } } | null)?.code ??
    (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23505';
}
