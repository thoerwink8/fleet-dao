// routing_catalog 副本的读写：只由引擎的对账写；判认不认得出由 @fleet-dao/core 的
// routing-catalog.ts 判（resolveRoutingCatalog），这里照着写、原样读，不补默认值。
//
// 幂等（specs/574 怎么算做完）：同一份「payload + commit」连写两遍，第二遍应当只更新
// checkedAt / 清掉 lastError、不动其他列。这由调用方先 select 一次再决定 upsert 还是
// 只 touched 实现——不依赖数据库 upsert 的「每次都写」行为，免得 payload 行不变也刷 updatedAt。
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { routingCatalog } from '../schema/index.ts';

export interface RoutingCatalogRow {
  source: string;
  payload: Record<string, unknown>;
  commit: string;
  purposesVersion: number;
  syncedAt: Date;
  checkedAt: Date;
  lastError: string | null;
  status: 'fresh' | 'stale' | 'blocked';
}

type Row = typeof routingCatalog.$inferSelect;

const toEntry = (r: Row): RoutingCatalogRow => ({ ...r, payload: r.payload });

/** 按 source 读一份副本；没读过是 null。 */
export async function getRoutingCatalog(db: Db, source: string): Promise<RoutingCatalogRow | null> {
  const rows = await db.select().from(routingCatalog).where(eq(routingCatalog.source, source));
  return rows.length ? toEntry(rows[0] as Row) : null;
}

/** canonical JSON：键按字典序，数组顺序原位。jsonb 不保留键序，写进库再读出来 JSON.stringify 不一样，
 * 拿它判断「两份 payload 是不是同一份」会误判（于是把 purposesVersion 白白 +1）。 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`);
  return `{${entries.join(',')}}`;
}

/** 全量覆盖（对账第一步）：清空 lastError、置 fresh、purposesVersion +1。 */
export async function writeRoutingCatalogFresh(
  db: Db,
  entry: Omit<RoutingCatalogRow, 'purposesVersion' | 'lastError' | 'status'>,
): Promise<void> {
  const existing = await getRoutingCatalog(db, entry.source);
  const same =
    existing !== null &&
    existing.commit === entry.commit &&
    canonicalJson(existing.payload) === canonicalJson(entry.payload);
  if (same) {
    // 幂等：同一份连写两遍，只刷新读的时刻和清错误；版本号不动。
    await db
      .update(routingCatalog)
      .set({ checkedAt: entry.checkedAt, syncedAt: entry.syncedAt, lastError: null, status: 'fresh' })
      .where(eq(routingCatalog.source, entry.source));
    return;
  }
  if (existing === null) {
    await db.insert(routingCatalog).values({
      ...entry,
      purposesVersion: 1,
      lastError: null,
      status: 'fresh',
    });
    return;
  }
  await db
    .update(routingCatalog)
    .set({
      payload: entry.payload,
      commit: entry.commit,
      syncedAt: entry.syncedAt,
      checkedAt: entry.checkedAt,
      lastError: null,
      status: 'fresh',
      purposesVersion: existing.purposesVersion + 1,
    })
    .where(eq(routingCatalog.source, entry.source));
}

/** 这一轮没读成：标 stale、留 lastError，保留旧 payload 和 commit（旧的照样能派）。 */
export async function markRoutingCatalogStale(
  db: Db,
  source: string,
  checkedAt: Date,
  lastError: string,
): Promise<void> {
  const existing = await getRoutingCatalog(db, source);
  if (existing === null) {
    // 从没读成过也用占位行记下来：payload 用空对象，check 会拦，所以这里必须写合规形状；先用空洞、commit 用占位
    // 的版本串。这是「没读过就坏了」的边界——写明、不静默。
    await db.insert(routingCatalog).values({
      source,
      payload: { formatVersion: 1, purposes: {}, models: {} },
      commit: '0'.repeat(40),
      purposesVersion: 1,
      syncedAt: checkedAt,
      checkedAt,
      lastError,
      status: 'stale',
    });
    return;
  }
  await db
    .update(routingCatalog)
    .set({ checkedAt, lastError, status: 'stale' })
    .where(eq(routingCatalog.source, source));
}

/** 主线上出了这版引擎认不出的更新格式：整份堵住、不派、也不往前追。 */
export async function markRoutingCatalogBlocked(
  db: Db,
  source: string,
  checkedAt: Date,
  lastError: string,
): Promise<void> {
  const existing = await getRoutingCatalog(db, source);
  if (existing === null) {
    await db.insert(routingCatalog).values({
      source,
      payload: { formatVersion: 1, purposes: {}, models: {} },
      commit: '0'.repeat(40),
      purposesVersion: 1,
      syncedAt: checkedAt,
      checkedAt,
      lastError,
      status: 'blocked',
    });
    return;
  }
  await db
    .update(routingCatalog)
    .set({ checkedAt, lastError, status: 'blocked' })
    .where(eq(routingCatalog.source, source));
}
