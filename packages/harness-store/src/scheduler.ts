// 自建调度器（#3774，决定 0124 第 3 条）：持久定时、领取租约、心跳续租、取消一路传下去、截止时刻继承、按队列限速、重试到顶进 dead。
// 单实例单库：时刻一律按数据库 now()；领取用 FOR UPDATE SKIP LOCKED，同队列的领取在 queue_limits 那一行上排队，限速才数得准。
// 进程死了（被杀、OOM、SIGSTOP）不用另外收尸：租约过了别人照领，原领取者回来收尾时令牌对不上（LostClaimError）。
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { jobs, queueLimits } from './schema.ts';
import { type Db, LostClaimError, PAGE_MAX } from './store.ts';

export interface Job {
  id: number;
  queue: string;
  key: string;
  parentKey: string | null;
  payload: Record<string, unknown>;
  state: 'pending' | 'claimed' | 'done' | 'cancelled' | 'dead';
  attempts: number;
  maxAttempts: number;
  deadlineAt: Date | null;
  claimToken: string | null;
  lastError: string | null;
}

/** 队列没设限速：不让领（宁可不跑，也不在停机恢复时一下全放出去）。 */
export class NoQueueLimitError extends Error {
  constructor(queue: string) {
    super(`队列 ${queue} 没设限速（queue_limits 没有这一行），不领`);
    this.name = 'NoQueueLimitError';
  }
}

/** 设或改一个队列的限速。 */
export async function setQueueLimit(
  db: Db,
  queue: string,
  maxInflight: number,
  perMinute: number,
): Promise<void> {
  await db
    .insert(queueLimits)
    .values({ queue, maxInflight, perMinute })
    .onConflictDoUpdate({ target: queueLimits.queue, set: { maxInflight, perMinute } });
}

export interface ScheduleInput {
  queue: string;
  key: string;
  payload: Record<string, unknown>;
  /** 多久以后到点（毫秒，按数据库时钟）；不给就是现在。 */
  delayMs?: number;
  /** 从现在起多久以后截止（毫秒）；有父活时取两者更早的那个。 */
  deadlineInMs?: number;
  parentKey?: string;
  maxAttempts?: number;
}

/**
 * 排一件活：同一个 key 只进一次，再来回已有那条。有父活时截止时刻不晚于父活；父活已取消、已死就不排（回 refused）。
 */
export async function schedule(
  db: Db,
  input: ScheduleInput,
): Promise<{ kind: 'created' | 'existing'; job: Job } | { kind: 'refused'; why: string }> {
  return db.transaction(async (tx) => {
    let parentDeadline: Date | null = null;
    if (input.parentKey !== undefined) {
      const [parent] = await tx.select().from(jobs).where(eq(jobs.key, input.parentKey));
      if (!parent) return { kind: 'refused', why: `父活 ${input.parentKey} 不存在` } as const;
      if (parent.state === 'cancelled' || parent.state === 'dead') {
        return {
          kind: 'refused',
          why: `父活 ${input.parentKey} 已经${parent.state === 'cancelled' ? '取消' : '死了'}`,
        } as const;
      }
      parentDeadline = parent.deadlineAt;
    }
    const own =
      input.deadlineInMs === undefined
        ? null
        : sql`now() + make_interval(secs => ${input.deadlineInMs / 1000})`;
    const deadline =
      parentDeadline && own
        ? sql`least(${parentDeadline}::timestamptz, ${own})`
        : parentDeadline
          ? sql`${parentDeadline}::timestamptz`
          : own;
    const inserted = await tx
      .insert(jobs)
      .values({
        queue: input.queue,
        key: input.key,
        parentKey: input.parentKey ?? null,
        payload: input.payload,
        dueAt: sql`now() + make_interval(secs => ${(input.delayMs ?? 0) / 1000})` as unknown as Date,
        deadlineAt: (deadline ?? null) as unknown as Date | null,
        maxAttempts: input.maxAttempts ?? 5,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { kind: 'created', job: toJob(inserted[0]) } as const;
    const [had] = await tx.select().from(jobs).where(eq(jobs.key, input.key));
    if (!had) throw new Error(`活 ${input.key} 冲突却读不到原来那条`);
    return { kind: 'existing', job: toJob(had) } as const;
  });
}

/**
 * 领一个队列里到点的活：先把过了截止的收成 dead；再按限速算这次最多领几条（同时在领的、最近一分钟新领的都算），
 * 到点的 pending 和租约过期的 claimed 都能领；领到的 attempts 加一，超过上限的直接 dead、不交出去。
 */
export async function claimJobs(db: Db, queue: string, max: number, leaseMs: number): Promise<Job[]> {
  const token = randomUUID();
  return db.transaction(async (tx) => {
    const [limit] = await tx.select().from(queueLimits).where(eq(queueLimits.queue, queue)).for('update');
    if (!limit) throw new NoQueueLimitError(queue);
    await tx
      .update(jobs)
      .set({
        state: 'dead',
        lastError: '过了截止时刻还没做完',
        leaseUntil: null,
        claimToken: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(jobs.queue, queue),
          inArray(jobs.state, ['pending', 'claimed']),
          isNotNull(jobs.deadlineAt),
          lt(jobs.deadlineAt, sql`now()`),
        ),
      );
    const [inflight] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(eq(jobs.queue, queue), eq(jobs.state, 'claimed'), gte(jobs.leaseUntil, sql`now()`)));
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(eq(jobs.queue, queue), gt(jobs.claimedAt, sql`now() - interval '1 minute'`)));
    const room = Math.min(
      max,
      PAGE_MAX,
      limit.maxInflight - Number(inflight?.n ?? 0),
      limit.perMinute - Number(recent?.n ?? 0),
    );
    if (room <= 0) return [];
    const due = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.queue, queue),
          or(
            and(eq(jobs.state, 'pending'), lte(jobs.dueAt, sql`now()`)),
            and(eq(jobs.state, 'claimed'), lt(jobs.leaseUntil, sql`now()`)),
          ),
        ),
      )
      .orderBy(asc(jobs.dueAt), asc(jobs.id))
      .limit(room)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    const rows = await tx
      .update(jobs)
      .set({
        state: 'claimed',
        claimToken: token,
        claimedAt: sql`now()`,
        leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        inArray(
          jobs.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
    const over = rows.filter((r) => r.attempts > r.maxAttempts);
    if (over.length > 0) {
      await tx
        .update(jobs)
        .set({
          state: 'dead',
          lastError: sql`concat('领了 ', ${jobs.attempts} - 1, ' 次都没做完（多半是做的进程死了）：', coalesce(${jobs.lastError}, ''))`,
          leaseUntil: null,
          claimToken: null,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            jobs.id,
            over.map((r) => r.id),
          ),
        );
    }
    return rows.filter((r) => r.attempts <= r.maxAttempts).map(toJob);
  });
}

/** 心跳续租：还归你就续上回 ok；被取消了回 cancelled（马上停手）；被别人领走了回 lost（停手，结果别写）。 */
export async function heartbeat(db: Db, job: Job, leaseMs: number): Promise<'ok' | 'cancelled' | 'lost'> {
  if (!job.claimToken) return 'lost';
  const rows = await db
    .update(jobs)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, job.id), eq(jobs.state, 'claimed'), eq(jobs.claimToken, job.claimToken)))
    .returning({ id: jobs.id });
  if (rows.length > 0) return 'ok';
  const [now] = await db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, job.id));
  return now?.state === 'cancelled' ? 'cancelled' : 'lost';
}

async function settleJob(db: Db, job: Job, set: Partial<typeof jobs.$inferInsert>): Promise<void> {
  if (!job.claimToken) throw new LostClaimError(job.id);
  const rows = await db
    .update(jobs)
    .set({ ...set, leaseUntil: null, claimToken: null, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, job.id), eq(jobs.state, 'claimed'), eq(jobs.claimToken, job.claimToken)))
    .returning({ id: jobs.id });
  if (rows.length === 0) throw new LostClaimError(job.id);
}

/** 做完。 */
export function completeJob(db: Db, job: Job): Promise<void> {
  return settleJob(db, job, { state: 'done', lastError: null });
}

/** 没做成：退避后再排；次数到顶进 dead。 */
export function retryJob(db: Db, job: Job, why: string, backoffMs: number): Promise<void> {
  if (job.attempts >= job.maxAttempts) {
    return settleJob(db, job, { state: 'dead', lastError: `做了 ${job.attempts} 次都没成：${why}` });
  }
  return settleJob(db, job, {
    state: 'pending',
    lastError: why,
    dueAt: sql`now() + make_interval(secs => ${backoffMs / 1000})` as unknown as Date,
  });
}

/** 取消一件活和它所有的子孙（还没完的）。领着的人下次心跳拿到 cancelled。回一共取消了几件。 */
export async function cancelJob(db: Db, key: string, why: string): Promise<number> {
  return db.transaction(async (tx) => {
    let frontier = [key];
    const seen = new Set<string>();
    let total = 0;
    while (frontier.length > 0) {
      const batch = frontier.filter((k) => !seen.has(k));
      for (const k of batch) seen.add(k);
      if (batch.length === 0) break;
      const done = await tx
        .update(jobs)
        .set({
          state: 'cancelled',
          lastError: why,
          leaseUntil: null,
          claimToken: null,
          updatedAt: sql`now()`,
        })
        .where(and(inArray(jobs.key, batch), inArray(jobs.state, ['pending', 'claimed'])))
        .returning({ id: jobs.id });
      total += done.length;
      const children = await tx.select({ key: jobs.key }).from(jobs).where(inArray(jobs.parentKey, batch));
      frontier = children.map((c) => c.key);
    }
    return total;
  });
}

export interface QueueHealth {
  queue: string;
  /** 到点没领的最老一条等了多少秒；没有积压是 0。看调度有没有往前走，不只看进程活着。 */
  oldestDueSeconds: number;
  /** 同时在领（租约没过）的件数。 */
  inflight: number;
  /** 租约过了还挂着 claimed 的件数（做的进程多半死了，等别人领）。 */
  expiredLeases: number;
  dead: number;
}

/** 一个队列的健康数字。 */
export async function queueHealth(db: Db, queue: string): Promise<QueueHealth> {
  const [row] = await db
    .select({
      oldest: sql<number>`coalesce(extract(epoch from now() - min(${jobs.dueAt}) filter (where ${jobs.state} = 'pending' and ${jobs.dueAt} <= now())), 0)::float8`,
      inflight: sql<number>`(count(*) filter (where ${jobs.state} = 'claimed' and ${jobs.leaseUntil} >= now()))::int`,
      expired: sql<number>`(count(*) filter (where ${jobs.state} = 'claimed' and ${jobs.leaseUntil} < now()))::int`,
      dead: sql<number>`(count(*) filter (where ${jobs.state} = 'dead'))::int`,
    })
    .from(jobs)
    .where(eq(jobs.queue, queue));
  return {
    queue,
    oldestDueSeconds: Math.max(0, Number(row?.oldest ?? 0)),
    inflight: Number(row?.inflight ?? 0),
    expiredLeases: Number(row?.expired ?? 0),
    dead: Number(row?.dead ?? 0),
  };
}

function toJob(r: typeof jobs.$inferSelect): Job {
  return {
    id: r.id,
    queue: r.queue,
    key: r.key,
    parentKey: r.parentKey,
    payload: r.payload as Record<string, unknown>,
    state: r.state as Job['state'],
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    deadlineAt: r.deadlineAt,
    claimToken: r.claimToken,
    lastError: r.lastError,
  };
}
