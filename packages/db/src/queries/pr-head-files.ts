// 精确 PR 头的 numstat 快照。metadata 与文件同事务写入，零文件也是成功；旧行没有 metadata 就是未知。
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { prHeadFiles, prHeadSnapshots } from '../schema/work.ts';

export const PR_HEAD_FILES_MAX = 500;
export interface PrHeadFile {
  path: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
}
export interface PrHeadSnapshot {
  headSha: string;
  status: 'complete' | 'truncated' | 'unavailable';
  total: number | null;
  kept: number;
  reason: string | null;
  recordedAt: Date;
}
export interface PrHeadFilesRead {
  headSha: string;
  files: PrHeadFile[];
  snapshot?: PrHeadSnapshot;
}

/** total 是采集器截断前的真实总数。失败可留原因，但不能覆盖同头已成功采集的快照。 */
export async function recordPrHeadFiles(
  db: Db,
  input: {
    repoId: string;
    prNumber: number;
    headSha: string;
    files: readonly PrHeadFile[];
    total?: number;
    reason?: string;
  },
): Promise<{ written: number; truncated: boolean }> {
  if (!/^[0-9a-f]{40}$/.test(input.headSha) || !Number.isInteger(input.prNumber) || input.prNumber <= 0)
    throw new Error('PR 文件快照身份不合法');
  const paths = new Set(input.files.map((f) => f.path));
  if (paths.size !== input.files.length || input.files.some((f) => !f.path.trim()))
    throw new Error('PR 文件快照有空路径或重复路径');
  const total = input.reason === undefined ? (input.total ?? input.files.length) : null;
  if (total !== null && (!Number.isInteger(total) || total < input.files.length))
    throw new Error('PR 文件快照总数不合法');
  if (input.reason !== undefined && (!input.reason.trim() || input.files.length > 0))
    throw new Error('失败快照必须带原因且不带文件');
  const kept = input.files.slice(0, PR_HEAD_FILES_MAX);
  const truncated = total !== null && total > kept.length;
  const status = total === null ? 'unavailable' : truncated ? 'truncated' : 'complete';
  const reason =
    input.reason ?? (truncated ? `文件清单截断：共 ${total} 个，仅保存 ${kept.length} 个` : null);
  return db.transaction(async (tx) => {
    // 先占同头快照行再加锁，串行化同头重试；任何文件写入错误回滚 metadata。
    const key = and(
      eq(prHeadSnapshots.repoId, input.repoId),
      eq(prHeadSnapshots.prNumber, input.prNumber),
      eq(prHeadSnapshots.headSha, input.headSha),
    );
    const inserted = await tx
      .insert(prHeadSnapshots)
      .values({
        repoId: input.repoId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        status,
        total,
        kept: kept.length,
        reason,
      })
      .onConflictDoNothing()
      .returning();
    const [existing] = await tx.select().from(prHeadSnapshots).where(key).for('update');
    if (
      !inserted.length &&
      existing &&
      (existing.status === 'complete' || (existing.status === 'truncated' && status !== 'complete'))
    ) {
      return { written: existing.kept, truncated: existing.status === 'truncated' };
    }
    await tx
      .delete(prHeadFiles)
      .where(
        and(
          eq(prHeadFiles.repoId, input.repoId),
          eq(prHeadFiles.prNumber, input.prNumber),
          eq(prHeadFiles.headSha, input.headSha),
        ),
      );
    if (kept.length)
      await tx.insert(prHeadFiles).values(
        kept.map((f) => ({
          ...f,
          repoId: input.repoId,
          prNumber: input.prNumber,
          headSha: input.headSha,
          added: f.binary ? null : f.added,
          removed: f.binary ? null : f.removed,
        })),
      );
    if (!inserted.length)
      await tx
        .update(prHeadSnapshots)
        .set({ status, total, kept: kept.length, reason, recordedAt: new Date() })
        .where(key);
    return { written: kept.length, truncated };
  });
}

/** 只读指定的完整头；没有本头快照时只为诊断返回最近旧头，绝不据此判断 current。 */
export async function readPrHeadFiles(
  db: Db,
  repoId: string,
  prNumber: number,
  headSha: string,
): Promise<PrHeadFilesRead | null> {
  const [snapshot] = await db
    .select()
    .from(prHeadSnapshots)
    .where(
      and(
        eq(prHeadSnapshots.repoId, repoId),
        eq(prHeadSnapshots.prNumber, prNumber),
        eq(prHeadSnapshots.headSha, headSha),
      ),
    );
  if (snapshot) {
    const rows = await db
      .select()
      .from(prHeadFiles)
      .where(
        and(
          eq(prHeadFiles.repoId, repoId),
          eq(prHeadFiles.prNumber, prNumber),
          eq(prHeadFiles.headSha, headSha),
        ),
      );
    if (rows.length !== snapshot.kept) throw new Error('PR 文件快照 metadata 与文件数量不一致');
    return {
      headSha,
      snapshot,
      files: rows
        .map(({ path, added, removed, binary }) => ({ path, added, removed, binary }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
  return readLatestPrHeadFiles(db, repoId, prNumber);
}

/** 兼容历史诊断；API 正常读取必须调用 readPrHeadFiles 并核对精确头。 */
export async function readLatestPrHeadFiles(
  db: Db,
  repoId: string,
  prNumber: number,
): Promise<PrHeadFilesRead | null> {
  const [snapshot] = await db
    .select()
    .from(prHeadSnapshots)
    .where(and(eq(prHeadSnapshots.repoId, repoId), eq(prHeadSnapshots.prNumber, prNumber)))
    .orderBy(desc(prHeadSnapshots.recordedAt))
    .limit(1);
  if (snapshot) return readPrHeadFiles(db, repoId, prNumber, snapshot.headSha);
  const [latest] = await db
    .select()
    .from(prHeadFiles)
    .where(and(eq(prHeadFiles.repoId, repoId), eq(prHeadFiles.prNumber, prNumber)))
    .orderBy(desc(prHeadFiles.recordedAt))
    .limit(1);
  if (!latest) return null;
  const rows = await db
    .select()
    .from(prHeadFiles)
    .where(
      and(
        eq(prHeadFiles.repoId, repoId),
        eq(prHeadFiles.prNumber, prNumber),
        eq(prHeadFiles.headSha, latest.headSha),
      ),
    );
  return {
    headSha: latest.headSha,
    files: rows.map(({ path, added, removed, binary }) => ({ path, added, removed, binary })),
  };
}
