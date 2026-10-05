// 整池暂停开关（#746）：设置表里 engine.poolHolds 那一行的原值。认不认得出由 shared 的 resolvePoolHolds 判；这里只管读。
import { POOL_HOLDS_SETTING } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { pools, settings } from '../schema/index.ts';

/** 没设过 = { set: false }（没有暂停）；设过原样给值和版本。库读不了照抛，不当成没有暂停。 */
export async function readPoolHoldsSetting(
  db: Db,
): Promise<{ set: false } | { set: true; value: unknown; version: number; since: Date; by: string | null }> {
  const [row] = await db.select().from(settings).where(eq(settings.key, POOL_HOLDS_SETTING));
  if (!row) return { set: false };
  return { set: true, value: row.value, version: row.version, since: row.updatedAt, by: row.updatedBy };
}

/** 库里所有账号池的编号（整份暂停设置认不出、所有池都按暂停办时用）。 */
export async function listPoolIds(db: Db): Promise<string[]> {
  return (await db.select({ id: pools.id }).from(pools)).map((r) => r.id);
}
