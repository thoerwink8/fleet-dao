// 会话用户切号的账本和锁（#194，方案 v2 第六节第 13 条）。账本本体 doc 的形状由引擎认（engine 的 real/org-ledger.ts），
// 这里只管存、取、拿锁、放锁：
// - 取：没有这一行回 null（引擎当作「从没切过」）；有就原样给 doc，认不认得出由引擎判，认不出它会明确失败。
// - 锁：单飞，一次只一个拿着；过期的（引擎做到一半重启没放）下一个能拿；同一个持有人可以重入续期。
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { sessionOrgState } from '../schema/index.ts';

export interface OrgStateRow {
  doc: unknown;
  updatedAt: Date;
  lockHolder: string | null;
  lockUntil: Date | null;
}

export async function readOrgState(db: Db, userName: string): Promise<OrgStateRow | null> {
  const [row] = await db.select().from(sessionOrgState).where(eq(sessionOrgState.userName, userName));
  if (!row) return null;
  return { doc: row.doc, updatedAt: row.updatedAt, lockHolder: row.lockHolder, lockUntil: row.lockUntil };
}

/** 整份账本写进去（有就换、没有就建）。锁两列不动。 */
export async function saveOrgState(db: Db, userName: string, doc: unknown, now: Date): Promise<void> {
  await db
    .insert(sessionOrgState)
    .values({ userName, doc, updatedAt: now })
    .onConflictDoUpdate({ target: sessionOrgState.userName, set: { doc, updatedAt: now } });
}

/**
 * 拿切号的锁：成了回 true。没人拿着、锁已过期、或者就是自己拿着的，才拿得到；别人拿着且没过期回 false。
 * 这一行还没有时先建一行（doc 用 emptyDoc），再抢。
 */
export async function takeOrgLock(
  db: Db,
  userName: string,
  options: { holder: string; now: Date; ttlMs: number; emptyDoc: unknown },
): Promise<boolean> {
  await db
    .insert(sessionOrgState)
    .values({ userName, doc: options.emptyDoc, updatedAt: options.now })
    .onConflictDoNothing({ target: sessionOrgState.userName });
  const taken = await db
    .update(sessionOrgState)
    .set({ lockHolder: options.holder, lockUntil: new Date(options.now.getTime() + options.ttlMs) })
    .where(
      and(
        eq(sessionOrgState.userName, userName),
        or(
          isNull(sessionOrgState.lockHolder),
          isNull(sessionOrgState.lockUntil),
          lt(sessionOrgState.lockUntil, options.now),
          eq(sessionOrgState.lockHolder, options.holder),
        ),
      ),
    )
    .returning({ userName: sessionOrgState.userName });
  return taken.length > 0;
}

/** 放锁：只放自己拿着的（过期后被别人接手了的，别把人家的锁放掉）。 */
export async function releaseOrgLock(db: Db, userName: string, holder: string): Promise<void> {
  await db
    .update(sessionOrgState)
    .set({ lockHolder: null, lockUntil: null })
    .where(and(eq(sessionOrgState.userName, userName), eq(sessionOrgState.lockHolder, holder)));
}
