// 只凭 HTTP 401 的共享记号（设置 engine.bare401）：同一个池短时间里的第二次才暂停整池，
// 第一次可能出在别的任务上。不放进工作流内存。库读不了、值认不出照抛，不当成「还没有」。
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { settings } from '../schema/index.ts';

export const BARE_401_SETTING = 'engine.bare401';

export interface Bare401StampRow {
  at: string;
  claim: string;
  repeated: boolean;
}

function poolsOf(value: unknown): Record<string, Bare401StampRow> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`设置 ${BARE_401_SETTING} 认不出（要 {pools:{…}}）：${JSON.stringify(value)}`);
  }
  const raw = (value as { pools?: unknown }).pools ?? {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`设置 ${BARE_401_SETTING} 的 pools 认不出：${JSON.stringify(value)}`);
  }
  const out: Record<string, Bare401StampRow> = {};
  for (const [id, stamp] of Object.entries(raw)) {
    if (
      stamp === null ||
      typeof stamp !== 'object' ||
      typeof (stamp as { at?: unknown }).at !== 'string' ||
      typeof (stamp as { claim?: unknown }).claim !== 'string' ||
      typeof (stamp as { repeated?: unknown }).repeated !== 'boolean'
    ) {
      throw new Error(`设置 ${BARE_401_SETTING} 里池 ${id} 的记号认不出：${JSON.stringify(stamp)}`);
    }
    const row = stamp as Bare401StampRow;
    out[id] = { at: row.at, claim: row.claim, repeated: row.repeated };
  }
  return out;
}

/**
 * 锁住这一行，把某个池的记号交给 next 改，再写回去。没有这一行就先补上空的。
 * next 在锁里面跑，两个任务同时来也不会互相盖掉。
 */
export async function updateBare401Stamp(
  db: Db,
  poolId: string,
  next: (existing: Bare401StampRow | undefined) => { stamp: Bare401StampRow; repeated: boolean },
): Promise<{ repeated: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: BARE_401_SETTING, value: { pools: {} }, updatedBy: 'engine' })
      .onConflictDoNothing({ target: settings.key });
    const [row] = await tx.select().from(settings).where(eq(settings.key, BARE_401_SETTING)).for('update');
    if (!row) throw new Error(`设置 ${BARE_401_SETTING} 补上之后仍读不到`);
    const pools = poolsOf(row.value);
    const { stamp, repeated } = next(pools[poolId]);
    pools[poolId] = stamp;
    await tx
      .update(settings)
      .set({ value: { pools }, version: sql`${settings.version} + 1`, updatedBy: 'engine' })
      .where(eq(settings.key, BARE_401_SETTING));
    return { repeated };
  });
}
