// 看门狗的「健康页非 200 持续 >10 分钟」要记的一件事：这一段不健康是从几点起的（设置表里 engine.healthzBadSince 那一行）。
// 引擎重启也不丢，所以不放进程内存。没有这一行 = 上一轮看到的是健康。读不到、值认不出照抛，不当成「刚坏」。
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { settings } from '../schema/index.ts';

export const HEALTHZ_BAD_SINCE_SETTING = 'engine.healthzBadSince';

/** 读这一段不健康从几点起；没有是 null。值认不出照抛。 */
export async function readHealthzBadSince(db: Db): Promise<Date | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, HEALTHZ_BAD_SINCE_SETTING));
  if (!row) return null;
  const v = row.value as { since?: unknown } | null;
  const since = typeof v?.since === 'string' ? new Date(v.since) : null;
  if (since === null || Number.isNaN(since.getTime())) {
    throw new Error(
      `设置 ${HEALTHZ_BAD_SINCE_SETTING} 的值认不出（要 {since: 时间}）：${JSON.stringify(row.value)}`,
    );
  }
  return since;
}

/** 记这一段从几点起（已经有就不动：只记第一次看到不健康的时刻）。 */
export async function writeHealthzBadSince(db: Db, input: { since: Date; by: string }): Promise<void> {
  await db
    .insert(settings)
    .values({
      key: HEALTHZ_BAD_SINCE_SETTING,
      value: { since: input.since.toISOString() },
      updatedBy: input.by,
    })
    .onConflictDoNothing({ target: settings.key });
}

/** 健康了：清掉。 */
export async function clearHealthzBadSince(db: Db): Promise<void> {
  await db.delete(settings).where(eq(settings.key, HEALTHZ_BAD_SINCE_SETTING));
}
