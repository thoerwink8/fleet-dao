// 本机定时（#3929）。到点与否用调用方传入的时刻，不用数据库 now()：测试要换钟。
import { and, asc, eq, lte, ne } from 'drizzle-orm';
import { adeSchedules } from './schema.ts';
import { type Db, PAGE_MAX } from './store.ts';

export type AdeScheduleRow = typeof adeSchedules.$inferSelect;

const DUE_PAGE = 20;

export async function listAdeSchedules(db: Db, limit = 100): Promise<AdeScheduleRow[]> {
  return db
    .select()
    .from(adeSchedules)
    .orderBy(asc(adeSchedules.runAt), asc(adeSchedules.id))
    .limit(Math.min(Math.max(limit, 1), PAGE_MAX));
}

export async function getAdeSchedule(db: Db, id: string): Promise<AdeScheduleRow | null> {
  const [row] = await db.select().from(adeSchedules).where(eq(adeSchedules.id, id));
  return row ?? null;
}

export async function insertAdeSchedule(
  db: Db,
  row: {
    id: string;
    workspaceId: string;
    agent: string;
    model: string;
    prompt: string;
    runAt: Date;
  },
): Promise<void> {
  await db.insert(adeSchedules).values({
    ...row,
    status: 'active',
    sessionId: null,
    lastError: null,
  });
}

/** 还在等、而且 run_at 不晚于 now 的一页。按到点时刻再按 id，下一拍接着领剩下的。 */
export async function listDueAdeSchedules(db: Db, now: Date, limit = DUE_PAGE): Promise<AdeScheduleRow[]> {
  return db
    .select()
    .from(adeSchedules)
    .where(and(eq(adeSchedules.status, 'active'), lte(adeSchedules.runAt, now)))
    .orderBy(asc(adeSchedules.runAt), asc(adeSchedules.id))
    .limit(Math.min(Math.max(limit, 1), PAGE_MAX));
}

/** active 且已到点才改成 firing。别人领过了就返回 null。 */
export async function claimAdeSchedule(db: Db, id: string, now: Date): Promise<AdeScheduleRow | null> {
  const [row] = await db
    .update(adeSchedules)
    .set({ status: 'firing', updatedAt: now })
    .where(and(eq(adeSchedules.id, id), eq(adeSchedules.status, 'active'), lte(adeSchedules.runAt, now)))
    .returning();
  return row ?? null;
}

export async function finishAdeSchedule(db: Db, id: string, sessionId: string, now: Date): Promise<void> {
  await db
    .update(adeSchedules)
    .set({ status: 'done', sessionId, lastError: null, updatedAt: now })
    .where(and(eq(adeSchedules.id, id), eq(adeSchedules.status, 'firing')));
}

export async function failAdeSchedule(db: Db, id: string, lastError: string, now: Date): Promise<void> {
  await db
    .update(adeSchedules)
    .set({ status: 'error', lastError, updatedAt: now })
    .where(and(eq(adeSchedules.id, id), eq(adeSchedules.status, 'firing')));
}

export async function pauseAdeSchedule(db: Db, id: string, now: Date): Promise<AdeScheduleRow | null> {
  const [row] = await db
    .update(adeSchedules)
    .set({ status: 'paused', updatedAt: now })
    .where(and(eq(adeSchedules.id, id), eq(adeSchedules.status, 'active')))
    .returning();
  return row ?? null;
}

/** 正在 firing 的不删。 */
export async function deleteAdeSchedule(db: Db, id: string): Promise<'deleted' | 'missing' | 'firing'> {
  const [row] = await db
    .delete(adeSchedules)
    .where(and(eq(adeSchedules.id, id), ne(adeSchedules.status, 'firing')))
    .returning({ id: adeSchedules.id });
  if (row) return 'deleted';
  const cur = await getAdeSchedule(db, id);
  if (!cur) return 'missing';
  return cur.status === 'firing' ? 'firing' : 'missing';
}

/** 内核重启时还停在 firing 的改成 error，不再自动开，人可以删。 */
export async function releaseFiringSchedules(db: Db, now: Date): Promise<number> {
  const rows = await db
    .update(adeSchedules)
    .set({
      status: 'error',
      lastError: '内核重启时这条定时正在开会话，没有记成已触发',
      updatedAt: now,
    })
    .where(eq(adeSchedules.status, 'firing'))
    .returning({ id: adeSchedules.id });
  return rows.length;
}
