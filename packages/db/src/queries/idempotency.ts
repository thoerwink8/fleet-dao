// 外部写操作（GitHub 评论、开 PR、关单……）防重复：写之前占键，写成了记回执，失败了放键。
// 放在库里而不是本机文件：换机器、重启、从备份恢复后重放都能认出来。
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { idempotencyKeys } from '../schema/index.ts';

export type ClaimResult =
  /** 占到了：可以去写。 */
  | { status: 'claimed' }
  /** 以前写成过：别再写，直接用回执。 */
  | { status: 'done'; result: unknown; completedAt: Date }
  /** 别人占着还没写完（或写到一半死了）：先回读外部系统确认，别盲写。 */
  | { status: 'in-flight'; claimedAt: Date };

export async function claimIdempotencyKey(
  db: Db,
  input: { key: string; action: string; target?: string },
  now: Date = new Date(),
): Promise<ClaimResult> {
  const inserted = await db
    .insert(idempotencyKeys)
    .values({ key: input.key, action: input.action, target: input.target ?? null, claimedAt: now })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) return { status: 'claimed' };
  const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, input.key));
  if (!row) throw new Error(`幂等键 ${input.key} 占不到也读不到`);
  if (row.completedAt !== null) return { status: 'done', result: row.result, completedAt: row.completedAt };
  return { status: 'in-flight', claimedAt: row.claimedAt };
}

/** 写成了：记回执（URL、编号……）。键不存在或已完成就抛错。 */
export async function completeIdempotencyKey(
  db: Db,
  key: string,
  result: unknown,
  now: Date = new Date(),
): Promise<void> {
  const updated = await db
    .update(idempotencyKeys)
    .set({ completedAt: now, result })
    .where(and(eq(idempotencyKeys.key, key), isNull(idempotencyKeys.completedAt)))
    .returning({ key: idempotencyKeys.key });
  if (updated.length === 0) throw new Error(`幂等键 ${key} 没被占着，或者已经完成过`);
}

/** 确认没写成：放掉键，重试时可以重新占。已完成的键不放。返回是否放掉了。 */
export async function releaseIdempotencyKey(db: Db, key: string): Promise<boolean> {
  const deleted = await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key), isNull(idempotencyKeys.completedAt)))
    .returning({ key: idempotencyKeys.key });
  return deleted.length > 0;
}
