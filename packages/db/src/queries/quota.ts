// 额度：写入口 savePoolQuota / upsertQuotaWindow，驾驶舱「额度表」quotaTable，以及判一个窗口能不能用的 windowState（调度也用它）。
import type { QuotaWindow, ScopeMembership } from '@fleet-dao/shared';
import { and, asc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { channels, pools, quotaWindows, routes, sessionRuns } from '../schema/index.ts';

/** 读数超过这么久没更新就不当现值（设计 §6：每个账号池的额度读数不超过 30 分钟）。 */
export const QUOTA_STALE_AFTER_MS = 30 * 60_000;

/**
 * ok：能用；exhausted：用满了；stale：读数太旧，没查成（不当「还够」）；reset：清零时刻已过，旧读数作废，等下一次读。
 * 用满的窗口在清零前不会自己变回有余，所以已知清零时刻的「用满」即使读数旧了也仍算用满。
 */
export type WindowState = 'ok' | 'exhausted' | 'stale' | 'reset';

type WindowReading = Pick<
  typeof quotaWindows.$inferSelect,
  'utilization' | 'used' | 'limit' | 'upstreamStatus' | 'resetsAt' | 'readAt'
>;

export function windowState(w: WindowReading, now: Date, staleAfterMs = QUOTA_STALE_AFTER_MS): WindowState {
  if (w.resetsAt !== null && w.resetsAt.getTime() <= now.getTime()) return 'reset';
  const full =
    w.upstreamStatus === 'limit_reached' ||
    (w.utilization !== null && w.utilization >= 1) ||
    (w.used !== null && w.limit !== null && w.used >= w.limit);
  const stale = now.getTime() - w.readAt.getTime() > staleAfterMs;
  if (full && (!stale || w.resetsAt !== null)) return 'exhausted';
  if (stale) return 'stale';
  return full ? 'exhausted' : 'ok';
}

/** 还剩几成（0–1）；算不出来就是空。 */
export function remainingRatio(w: Pick<WindowReading, 'utilization' | 'used' | 'limit'>): number | null {
  if (w.utilization !== null) return Math.max(0, 1 - w.utilization);
  if (w.used !== null && w.limit !== null && w.limit > 0) return Math.max(0, 1 - w.used / w.limit);
  return null;
}

/** 入库的窗口：label、unit、source 在领域对象里可选，入库必填。 */
export type StoredQuotaWindow = QuotaWindow & Required<Pick<QuotaWindow, 'label' | 'unit' | 'source'>>;

/**
 * 写一个窗口：按（池, label）覆盖。晚到的旧读数（read_at 比库里的还早）不覆盖新的；返回是否写进去了。
 * 一次读到一整个池的，用 savePoolQuota。
 */
export async function upsertQuotaWindow(db: Db, w: StoredQuotaWindow): Promise<boolean> {
  const changes = {
    window: w.window,
    scope: w.scope ?? '',
    utilization: w.utilization ?? null,
    used: w.used ?? null,
    limit: w.limit ?? null,
    unit: w.unit,
    resetsAt: w.resetsAt ? new Date(w.resetsAt) : null,
    upstreamStatus: w.upstreamStatus ?? null,
    statusRaw: w.statusRaw ?? null,
    reading: w.reading,
    source: w.source,
    readAt: new Date(w.readAt),
  };
  const written = await db
    .insert(quotaWindows)
    .values({ poolId: w.poolId, label: w.label, ...changes })
    .onConflictDoUpdate({
      target: [quotaWindows.poolId, quotaWindows.label],
      set: changes,
      setWhere: sql`${quotaWindows.readAt} <= excluded.read_at`,
    })
    .returning({ poolId: quotaWindows.poolId });
  return written.length > 0;
}

/** 读取器读一个账号池的结果（和 adapters 额度读取器的 PoolReadOk 对得上）。 */
export interface PoolQuotaSnapshot {
  poolId: string;
  /** 这次读的时刻。库里已有比它新的读数时，池上的到期日和成员表不跟着改（晚到的旧读数不覆盖新的）。 */
  readAt: string;
  windows: readonly StoredQuotaWindow[];
  /** 读数里的订阅到期日（目前只有 Cursor 给账期末）。给了就写进 pools.expires_at，没给不动。 */
  expiresAt?: string;
  /** 读数里的模型组成员表。给了就写进 pools.scope_models，没给不动。 */
  scopeModels?: Record<string, ScopeMembership>;
}

/**
 * 额度账的写入口：一个池一次读到的全部窗口 + 订阅到期日 + 成员表，同一事务写。
 * 返回写进去的窗口数和因为更旧没写的窗口数。上游这次没报的窗口不删（还留着旧读数，会按过期显示）。
 */
export async function savePoolQuota(
  db: Db,
  snapshot: PoolQuotaSnapshot,
): Promise<{ written: number; skippedAsOlder: number }> {
  const labels = new Set<string>();
  for (const w of snapshot.windows) {
    if (w.poolId !== snapshot.poolId) {
      throw new Error(`窗口 ${w.label} 属于池 ${w.poolId}，不是这次读的池 ${snapshot.poolId}`);
    }
    if (labels.has(w.label)) throw new Error(`池 ${snapshot.poolId} 的这次读数里窗口 ${w.label} 出现了两次`);
    labels.add(w.label);
  }
  const readAt = new Date(snapshot.readAt);
  return db.transaction(async (tx) => {
    const [pool] = await tx.select({ id: pools.id }).from(pools).where(eq(pools.id, snapshot.poolId));
    if (!pool) throw new Error(`没有这个账号池：${snapshot.poolId}`);
    const [newest] = await tx
      .select({ at: max(quotaWindows.readAt) })
      .from(quotaWindows)
      .where(eq(quotaWindows.poolId, snapshot.poolId));
    const olderThanStored = newest?.at != null && newest.at.getTime() > readAt.getTime();
    if (!olderThanStored && (snapshot.expiresAt !== undefined || snapshot.scopeModels !== undefined)) {
      await tx
        .update(pools)
        .set({
          ...(snapshot.expiresAt !== undefined && { expiresAt: new Date(snapshot.expiresAt) }),
          ...(snapshot.scopeModels !== undefined && { scopeModels: snapshot.scopeModels }),
        })
        .where(eq(pools.id, snapshot.poolId));
    }
    let written = 0;
    for (const w of snapshot.windows) if (await upsertQuotaWindow(tx, w)) written++;
    return { written, skippedAsOlder: snapshot.windows.length - written };
  });
}

/** 每个账号池正在跑的会话数（已开始、没结束）。并发按池算，不按渠道或执行方式算。 */
export async function inFlightByPool(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ poolId: routes.poolId, n: sql<number>`count(*)::int` })
    .from(sessionRuns)
    .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
    .where(and(isNotNull(sessionRuns.startedAt), isNull(sessionRuns.endedAt)))
    .groupBy(routes.poolId);
  return new Map(rows.map((r) => [r.poolId, r.n]));
}

type WindowRow = typeof quotaWindows.$inferSelect;

export interface QuotaTableWindow {
  /** 上游的原名。 */
  label: string;
  window: WindowRow['window'];
  /** 模型组窗口的组名；账号级窗口为空。 */
  scope: string | null;
  utilization: number | null;
  used: number | null;
  limit: number | null;
  unit: WindowRow['unit'];
  remainingRatio: number | null;
  resetsAt: Date | null;
  /** 离清零还有多久；不知道清零时刻就是空。 */
  resetsInMs: number | null;
  upstreamStatus: WindowRow['upstreamStatus'];
  statusRaw: string | null;
  /** 实读还是估算。 */
  reading: WindowRow['reading'];
  /** 读法。 */
  source: string;
  readAt: Date;
  state: WindowState;
}

export interface QuotaTablePool {
  poolId: string;
  channelId: string;
  channelName: string;
  billing: (typeof channels.$inferSelect)['billing'];
  channelEnabled: boolean;
  maxConcurrency: number;
  inFlight: number;
  expiresAt: Date | null;
  scopeModels: Record<string, ScopeMembership> | null;
  /** 这个池一次额度都没读到过：显示「没查成」，不是「没有额度」。 */
  neverRead: boolean;
  /** 按清零时刻排，快清零的在前；同时清零的按原名。 */
  windows: QuotaTableWindow[];
}

export interface QuotaTableOptions {
  now?: Date;
  staleAfterMs?: number;
}

/** 驾驶舱「额度表」：每个账号池一行（没读数的池也列出来），下挂每个时间窗。 */
export async function quotaTable(db: Db, options: QuotaTableOptions = {}): Promise<QuotaTablePool[]> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? QUOTA_STALE_AFTER_MS;
  const poolRows = await db
    .select({ pool: pools, channel: channels })
    .from(pools)
    .innerJoin(channels, eq(channels.id, pools.channelId))
    .orderBy(asc(pools.channelId), asc(pools.id));
  const windowRows = await db.select().from(quotaWindows);
  const inFlight = await inFlightByPool(db);

  const byPool = new Map<string, QuotaTableWindow[]>();
  for (const w of windowRows) {
    const list = byPool.get(w.poolId) ?? [];
    list.push({
      label: w.label,
      window: w.window,
      scope: w.scope === '' ? null : w.scope,
      utilization: w.utilization,
      used: w.used,
      limit: w.limit,
      unit: w.unit,
      remainingRatio: remainingRatio(w),
      resetsAt: w.resetsAt,
      resetsInMs: w.resetsAt === null ? null : w.resetsAt.getTime() - now.getTime(),
      upstreamStatus: w.upstreamStatus,
      statusRaw: w.statusRaw,
      reading: w.reading,
      source: w.source,
      readAt: w.readAt,
      state: windowState(w, now, staleAfterMs),
    });
    byPool.set(w.poolId, list);
  }

  const resetKey = (w: QuotaTableWindow) => w.resetsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return poolRows.map(({ pool, channel }) => {
    const windows = (byPool.get(pool.id) ?? []).sort(
      (a, b) => resetKey(a) - resetKey(b) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    );
    return {
      poolId: pool.id,
      channelId: channel.id,
      channelName: channel.name,
      billing: channel.billing,
      channelEnabled: channel.enabled,
      maxConcurrency: pool.maxConcurrency,
      inFlight: inFlight.get(pool.id) ?? 0,
      expiresAt: pool.expiresAt,
      scopeModels: pool.scopeModels,
      neverRead: windows.length === 0,
      windows,
    };
  });
}
