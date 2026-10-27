// 工作树归档的回收：已经推到远端的归档，过一段时间就没有保险价值，该回收。
//
// 为什么需要这一层：`preserve-worktree.ts` 只在删树那一刻判一次「有没有没推的提交」，判完写盘，
// 之后没有任何复查。提交后来推上去了，那份 bundle/pack 就变成纯粹的重复副本——它的体积等于树的
// 全部 git 历史（每份 ~130MB），而它已经不再提供任何保险。图片归档（`real/shots.ts`）有 keepDays
// 和 archiveMaxBytes 两道回收；工作树归档一道都没有，于是法国 VPS 上 10 天堆了 91G、633 个目录。
//
// 这一层只做回收，不动保全：判不清的一律留着（和保全那边「读失败留原树」同一条口径）。
//
// 判据（全部满足才回收）：
//   1. 归档里的 HEAD 提交已经在远端（调用方给「这个提交在不在远端」的口子）
//   2. 归档里没有未提交内容：`state.json` 记的每个文件，内容都等于 HEAD 树里的同名文件
//   3. 超过保留期（keepDays），或者总占用超上限（archiveMaxBytes）时按「最老优先」清到放得下
//
// 判不了的留着：HEAD 查不成、结构认不出、`state.json` 读不成、bundle 取不出树。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PortError } from '../ports.ts';
import { removeArchiveDir } from './complex-preserve.ts';

/** 归档保留期（天）和总占用上限（字节）。 */
export interface ArchiveRetentionLimits {
  /** 归档留几天；超过这个天数、并且 HEAD 已在远端、又没有未提交内容的，回收。 */
  keepDays: number;
  /** 所有工作树归档合计的上限；超了按「最老优先」清到放得下。 */
  archiveMaxBytes: number;
}

/** 跟图片归档同一套量级（`real/shots.ts` 的 SHOTS_LIMITS），但工作树归档大得多，给 20G / 14 天。 */
export const ARCHIVE_RETENTION_LIMITS: ArchiveRetentionLimits = {
  keepDays: 14,
  archiveMaxBytes: 20 * 1024 * 1024 * 1024,
};

/** 一条归档记录：目录、字节数、写盘时刻。 */
export interface ArchiveEntry {
  dir: string;
  bytes: number;
  at: number;
}

/** 回收判断要的口子。生产给真的，测试给假的。 */
export interface ArchiveRetentionDeps {
  /** 归档根目录（生产是 <stateDir>/archive）。 */
  archiveDir: string;
  /** 这个 HEAD 提交在不在远端？查不成返回 undefined（调用方据此留着，不删）。 */
  isHeadPushed: (head: string) => Promise<boolean | undefined>;
  /** 取 HEAD 树里每个文件的内容 sha256（路径 → sha256）。取不出返回 undefined。 */
  readHeadTree: (head: string, bundle: string) => Promise<Map<string, string> | undefined>;
  /** 删一个归档目录。生产用受限删（`removeArchiveDir`）；测试可换假的。 */
  removeDir?: (dir: string) => Promise<boolean>;
  now?: () => number;
}

/** 判一个归档能不能回收：能就返回原因，不能就返回留着的理由。 */
export type ArchiveVerdict = { recycle: true; reason: string } | { recycle: false; reason: string };

/** 归档目录里都有什么结构：receipt / state / manifest / empty / unknown。 */
export type ArchiveShape = 'receipt' | 'state' | 'manifest' | 'empty' | 'unknown';

export interface ArchiveFacts {
  dir: string;
  bytes: number;
  at: number;
  shape: ArchiveShape;
  head: string;
}

const SHAPE_FILES: readonly [string, ArchiveShape][] = [
  ['receipt.json', 'receipt'],
  ['state.json', 'state'],
  ['manifest.json', 'manifest'],
];

/** 读一个归档目录的事实：结构、HEAD、字节数、写盘时刻。读不成的结构记 unknown。 */
export async function readArchiveFacts(dir: string): Promise<ArchiveFacts> {
  const names = await readdir(dir).catch(() => undefined);
  const bytes = await dirBytes(dir);
  const at = await dirMtime(dir);
  if (!names) return { dir, bytes, at, shape: 'unknown', head: '' };
  for (const [file, shape] of SHAPE_FILES) {
    if (!names.includes(file)) continue;
    const head = await readHead(join(dir, file));
    return { dir, bytes, at, shape: head === undefined ? 'unknown' : shape, head: head ?? '' };
  }
  return { dir, bytes, at, shape: 'empty', head: '' };
}

/** 从回执里读 HEAD。读不成返回 undefined。 */
async function readHead(path: string): Promise<string | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    return undefined;
  }
  try {
    const row = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const head = typeof row.head === 'string' ? row.head : '';
    if (head) return head;
    const identity = typeof row.identity === 'string' ? row.identity : '';
    return identity.split('\n')[0] || '';
  } catch {
    return undefined;
  }
}

/**
 * 算「带不走、删了就丢」的状态有几项。
 *
 * `stash` 每一项都是真东西（bundle 带不走），全算。
 * `merge` 里混着两种：`MERGE_HEAD` / `MERGE_MSG` / `MERGE_MODE` / `AUTO_MERGE` / `CHERRY_PICK_HEAD` /
 * `REVERT_HEAD` / `REBASE_HEAD` 是**没做完的操作**，删了就丢；`ORIG_HEAD` 只是 git 记的「上次 HEAD 在哪」，
 * 它指向的提交在 HEAD 的历史里，bundle 里有，不算丢东西。线上 322 条归档（37G）全栽在这上面：
 * 判据把 ORIG_HEAD 也算成未完成操作，一条都回收不掉（#3699）。
 * 认不出名字的按「算一项」处理，宁可留着。
 */
function carriedCount(stash: unknown, merge: unknown): number {
  const stashed = Array.isArray(stash) ? stash.length : 0;
  let unfinished = 0;
  for (const item of Array.isArray(merge) ? merge : []) {
    const name = item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined;
    // ORIG_HEAD 指向的提交在 HEAD 历史里，bundle 带得走；别的（含认不出名字的）都按未完成操作算。
    if (name === 'ORIG_HEAD') continue;
    unfinished += 1;
  }
  return stashed + unfinished;
}

/**
 * state.json 记的东西：文件清单（路径 → 内容 sha256）、以及带不走的那几样（stash、没做完的合并/挑拣/变基）。
 * 没有 state.json 返回 null（干净归档）；读不成返回 undefined。
 *
 * `git bundle` 只带引用，带不走 stash 和 `.git/` 里那些操作状态文件——所以只要这两样有一样不是空的，
 * 这份归档就不是「工作区等于 HEAD」，删了就真丢了。这一条和保全那边 `recheckComplex` 的判法是同一个道理。
 * `ORIG_HEAD` 不算（见 `carriedCount`）。
 */
async function readSnapshotState(
  dir: string,
): Promise<{ files: Map<string, string>; carried: number } | null | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(join(dir, 'state.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return undefined;
  }
  try {
    const row = JSON.parse(raw.toString('utf8')) as { files?: unknown; stash?: unknown; merge?: unknown };
    const list = Array.isArray(row.files) ? row.files : [];
    const files = new Map<string, string>();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const f = item as { kind?: unknown; path?: unknown; sha256?: unknown };
      if (f.kind !== 'file' || typeof f.path !== 'string' || typeof f.sha256 !== 'string') continue;
      files.set(f.path, f.sha256);
    }
    return { files, carried: carriedCount(row.stash, row.merge) };
  } catch {
    return undefined;
  }
}

/** 判一个归档能不能回收。 */
export async function judgeArchive(facts: ArchiveFacts, deps: ArchiveRetentionDeps): Promise<ArchiveVerdict> {
  if (facts.shape === 'unknown') return { recycle: false, reason: '结构认不出' };
  if (facts.shape === 'empty') {
    return facts.bytes === 0 ? { recycle: true, reason: '空目录' } : { recycle: false, reason: '结构认不出' };
  }
  if (!facts.head) return { recycle: false, reason: '认不出 HEAD' };
  const pushed = await deps.isHeadPushed(facts.head);
  if (pushed === undefined) return { recycle: false, reason: 'HEAD 在不在远端查不成' };
  if (!pushed) return { recycle: false, reason: 'HEAD 不在远端' };
  const snapshot = await readSnapshotState(facts.dir);
  if (snapshot === undefined) return { recycle: false, reason: 'state.json 读不成' };
  if (snapshot === null) return { recycle: true, reason: '干净归档（只有 git 历史）' };
  // stash 和没做完的合并/挑拣/变基只在 `.git/` 里，bundle 带不走：有就不是「等于 HEAD」。
  if (snapshot.carried > 0)
    return { recycle: false, reason: `带 stash 或没做完的 git 操作（${snapshot.carried} 项）` };
  const tree = await deps.readHeadTree(facts.head, join(facts.dir, 'recovery.bundle'));
  if (!tree) return { recycle: false, reason: 'HEAD 树取不出' };
  let missing = 0;
  let changed = 0;
  for (const [path, sha] of snapshot.files) {
    const want = tree.get(path);
    if (want === undefined) missing += 1;
    else if (want !== sha) changed += 1;
  }
  if (missing || changed) return { recycle: false, reason: `有未提交内容（缺 ${missing} 改 ${changed}）` };
  return { recycle: true, reason: 'HEAD 已在远端，工作区等于 HEAD' };
}

/** 回收一轮：先按保留期清，再按上限清到放得下。返回清了哪些。 */
export async function recycleArchives(
  deps: ArchiveRetentionDeps,
  limits: ArchiveRetentionLimits,
): Promise<{ removed: ArchiveEntry[]; kept: number; bytesKept: number; failures: string[] }> {
  const remove = deps.removeDir ?? removeArchiveDir;
  const now = deps.now?.() ?? Date.now();
  const cutoff = now - limits.keepDays * 24 * 3600 * 1000;
  const failures: string[] = [];
  const removed: ArchiveEntry[] = [];
  let entries: ArchiveEntry[];
  try {
    entries = await listEntries(deps.archiveDir);
  } catch (error) {
    throw new PortError('READ_FAILED', '归档目录列不出，这一轮不回收', {
      retryable: true,
      details: { error: String(error) },
    });
  }
  // 先判每一条能不能回收（判不清的留着）
  const candidates: ArchiveEntry[] = [];
  for (const entry of entries) {
    try {
      const facts = await readArchiveFacts(entry.dir);
      const verdict = await judgeArchive({ ...facts, bytes: entry.bytes, at: entry.at }, deps);
      if (verdict.recycle) candidates.push(entry);
    } catch (error) {
      failures.push(`${entry.dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 过保留期的先清
  let bytesKept = entries.reduce((sum, e) => sum + e.bytes, 0);
  const overAge = candidates.filter((e) => e.at < cutoff).sort((a, b) => a.at - b.at);
  for (const entry of overAge) {
    if (await remove(entry.dir)) {
      removed.push(entry);
      bytesKept -= entry.bytes;
    } else {
      failures.push(`${entry.dir}: 删不掉`);
    }
  }
  // 还超上限就按最老优先继续清
  const rest = candidates.filter((e) => !removed.includes(e)).sort((a, b) => a.at - b.at);
  for (const entry of rest) {
    if (bytesKept <= limits.archiveMaxBytes) break;
    if (await remove(entry.dir)) {
      removed.push(entry);
      bytesKept -= entry.bytes;
    } else {
      failures.push(`${entry.dir}: 删不掉`);
    }
  }
  const keptCount = entries.length - removed.length;
  return { removed, kept: keptCount, bytesKept, failures };
}

/** 列归档根目录下的所有归档条目（只认 worktree-* 目录）。目录不在 = 还没有归档，不是失败。 */
async function listEntries(archiveDir: string): Promise<ArchiveEntry[]> {
  const names = await readdir(archiveDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const out: ArchiveEntry[] = [];
  for (const name of names) {
    if (!name.startsWith('worktree-')) continue;
    const dir = join(archiveDir, name);
    const bytes = await dirBytes(dir);
    const at = await dirMtime(dir);
    out.push({ dir, bytes, at });
  }
  return out;
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const full = join(dir, name);
    const info = await statSafe(full);
    if (info?.isDirectory()) total += await dirBytes(full);
    else total += info?.size ?? 0;
  }
  return total;
}

async function dirMtime(dir: string): Promise<number> {
  const info = await statSafe(dir);
  return info?.mtimeMs ?? 0;
}

async function statSafe(
  path: string,
): Promise<{ isDirectory(): boolean; size: number; mtimeMs: number } | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}
