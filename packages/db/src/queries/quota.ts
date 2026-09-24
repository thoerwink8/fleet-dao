// 额度：唯一写入口 upsertQuotaWindow，驾驶舱「额度表」quotaTable，以及判一个窗口能不能用的 windowState（调度也用它）。
import type { QuotaWindow } from '@fleet-dao/shared';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
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

/**
 * 额度账的唯一写入口：按（池, 窗口, 模型组）覆盖。
 * 晚到的旧读数（read_at 比库里的还早）不覆盖新的；返回是否写进去了。
 */
export async function upsertQuotaWindow(db: Db, w: QuotaWindow): Promise<boolean> {
  const row = {
    poolId: w.poolId,
    window: w.window,
    scope: w.scope ?? '',
    utilization: w.utilization ?? null,
    used: w.used ?? null,
    limit: w.limit ?? null,
    resetsAt: w.resetsAt ? new Date(w.resetsAt) : null,
    upstreamStatus: w.upstreamStatus ?? null,
    reading: w.reading,
    readAt: new Date(w.readAt),
  };
  const written = await db
    .insert(quotaWindows)
    .values(row)
    .onConflictDoUpdate({
      target: [quotaWindows.poolId, quotaWindows.window, quotaWindows.scope],
      set: {
        utilization: row.utilization,
        used: row.used,
        limit: row.limit,
        resetsAt: row.resetsAt,
        upstreamStatus: row.upstreamStatus,
        reading: row.reading,
        readAt: row.readAt,
      },
      setWhere: sql`${quotaWindows.readAt} <= excluded.read_at`,
    })
    .returning({ poolId: quotaWindows.poolId });
  return written.length > 0;
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

export interface QuotaTableWindow {
  window: (typeof quotaWindows.$inferSelect)['window'];
  /** 模型组窗口的组名；账号级窗口为空。 */
  scope: string | null;
  utilization: number | null;
  used: number | null;
  limit: number | null;
  remainingRatio: number | null;
  resetsAt: Date | null;
  /** 离清零还有多久；不知道清零时刻就是空。 */
  resetsInMs: number | null;
  upstreamStatus: (typeof quotaWindows.$inferSelect)['upstreamStatus'];
  /** 实读还是估算。 */
  reading: (typeof quotaWindows.$inferSelect)['reading'];
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
  /** 这个池一次额度都没读到过：显示「没查成」，不是「没有额度」。 */
  neverRead: boolean;
  /** 按清零时刻排，快清零的在前。 */
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
      window: w.window,
      scope: w.scope === '' ? null : w.scope,
      utilization: w.utilization,
      used: w.used,
      limit: w.limit,
      remainingRatio: remainingRatio(w),
      resetsAt: w.resetsAt,
      resetsInMs: w.resetsAt === null ? null : w.resetsAt.getTime() - now.getTime(),
      upstreamStatus: w.upstreamStatus,
      reading: w.reading,
      readAt: w.readAt,
      state: windowState(w, now, staleAfterMs),
    });
    byPool.set(w.poolId, list);
  }

  return poolRows.map(({ pool, channel }) => {
    const windows = (byPool.get(pool.id) ?? []).sort(
      (a, b) =>
        (a.resetsAt?.getTime() ?? Number.POSITIVE_INFINITY) -
        (b.resetsAt?.getTime() ?? Number.POSITIVE_INFINITY),
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
      neverRead: windows.length === 0,
      windows,
    };
  });
}
