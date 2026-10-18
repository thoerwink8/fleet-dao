// PR 的头改了哪些文件（pr_head_files，表的来龙去脉在 schema/work.ts）：引擎推分支后写、驾驶舱任务页读（#3140）。
//
// - 写：一个 (仓, PR, 头) 一次写全，同键冲突跳过（活动重试、重放不重复，也不改已经写进去的）。路径不能空；一个头最多记
//   PR_HEAD_FILES_MAX 个文件，超了只记前这么多并返回 truncated，调用方写日志。
// - 读：只读最新那个头（这个 PR 最近写进来的头）：不同头的行不混着加，所以不会把每个头重复算一遍。
//   「没写过」和「写了、零个文件」分开：没写过返回 null（页面写「没读到」），写过返回数组（可能空是不会的：没改文件的头不写，
//   也就是 null）。读不到（库不通）照抛。
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { prHeadFiles } from '../schema/work.ts';

export const PR_HEAD_FILES_MAX = 500;

export interface PrHeadFile {
  path: string;
  /** 二进制文件没有行数。 */
  added: number | null;
  removed: number | null;
  binary: boolean;
}

/** 写一个头的文件清单。返回写进去几行、是不是截断了（超出 PR_HEAD_FILES_MAX）。 */
export async function recordPrHeadFiles(
  db: Db,
  input: { repoId: string; prNumber: number; headSha: string; files: readonly PrHeadFile[] },
): Promise<{ written: number; truncated: boolean }> {
  const files = input.files.filter((f) => f.path.trim() !== '');
  if (files.length === 0) return { written: 0, truncated: false };
  const kept = files.slice(0, PR_HEAD_FILES_MAX);
  await db
    .insert(prHeadFiles)
    .values(
      kept.map((f) => ({
        repoId: input.repoId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        path: f.path,
        added: f.binary ? null : (f.added ?? 0),
        removed: f.binary ? null : (f.removed ?? 0),
        binary: f.binary,
      })),
    )
    .onConflictDoNothing();
  return { written: kept.length, truncated: files.length > kept.length };
}

/** 这个 PR 最新一个头的文件清单；一次都没写过返回 null。 */
export async function readLatestPrHeadFiles(
  db: Db,
  repoId: string,
  prNumber: number,
): Promise<{ headSha: string; files: PrHeadFile[] } | null> {
  const [latest] = await db
    .select({ headSha: prHeadFiles.headSha })
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
    files: rows
      .map((r) => ({ path: r.path, added: r.added, removed: r.removed, binary: r.binary }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}
