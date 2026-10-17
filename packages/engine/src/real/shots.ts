// 界面验收图片收树前的交付核对和受限归档（#2983）。图片的约定见 docs/design/驾驶舱界面.md 第七节：存在树里的
// _tmp/shots/<标签>/<图>，推到远端 shots/<单号> 的孤儿提交。起因：#2969 合并成功就直接收树，_tmp/shots/2969 的 21 张图和
// 没推的孤儿提交跟着树一起没了，远端、镜像、任务归档都没有副本。
//
// 规矩：
// - 只碰受管的：_tmp/shots/<标签>/ 下一层的 PNG/JPEG/WebP（看文件头，不只认扩展名），和树里没被任何引用指着、没有父提交、
//   里面只有这几种图片的孤儿提交。符号链接、层级不对、名字认不出、不是图片的一律拒收（列进 rejected，不存）；.env、凭据、
//   会话、日志、_tmp 别处一概不看。数量、单张、总量都有上限，超了算失败（树留着，不能默默丢）。
// - 交付按远端说话：远端 shots/<单号> 的树里有同样的 blob 号才算交付；本地文件、本地提交、文件非空都不算。引擎不推图片分支
//   （不新增权限，也就不会覆盖别的任务的分支）：没交付就存进受限归档，PR 说明里写明待交付。
// - 归档在 <归档>/<任务>/shots/<代码头>/：图片按 sha256 起名，manifest.json 记代码头、每张的路径、字节数、sha256、blob 号、
//   结局。同一任务同一个头重试：清单对得上就不重写；换了头另起目录；别的任务的目录只在过期时删。
// - 容量：所有任务的图片归档合计不超过 archiveMaxBytes；超过 keepDays 天的整目录删掉。删完还放不下就失败，树留着。
// - 读树里的东西一律以会话用户的身份（user-git.ts 的 runInTree / gitInTree）：引擎不以自己的身份进会话的目录。

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errMessage } from '@fleet-dao/shared/util';
import type { ShotFileRecord, ShotsDelivery, ShotsInput } from '../ports.ts';
import { describeFailure } from './exec.ts';
import { GIT, gitInTree, runInTree, SH, type UserTree } from './user-git.ts';

/** 树里图片目录（相对树根）。 */
export const SHOTS_DIR = '_tmp/shots';

export interface ShotsLimits {
  /** 一棵树里最多几张受管图片（树里的加孤儿提交里的）。 */
  maxFiles: number;
  maxFileBytes: number;
  /** 一棵树的图片合计（去重后）。 */
  maxTotalBytes: number;
  /** 最多看几个没父提交的孤儿提交。 */
  maxOrphanCommits: number;
  /** 所有任务的图片归档合计。 */
  archiveMaxBytes: number;
  /** 归档留几天，过了整目录删。 */
  keepDays: number;
}

export const SHOTS_LIMITS: ShotsLimits = {
  maxFiles: 200,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxOrphanCommits: 20,
  archiveMaxBytes: 2 * 1024 * 1024 * 1024,
  keepDays: 30,
};

/** 拒收清单最多记几条。 */
const REJECTED_MAX = 20;
/** 不可达提交最多看多少个（找没父提交的）。 */
const UNREACHABLE_SCAN_MAX = 500;
const SEG = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';
const LABEL = new RegExp(`^${SEG}$`);
const IMAGE_NAME = new RegExp(`^${SEG}\\.(?:png|jpe?g|webp)$`, 'i');
const SHA = /^[0-9a-f]{40}$/;
const TASK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type ImageKind = 'png' | 'jpeg' | 'webp';

/** 看文件头认图片：PNG、JPEG、WebP；别的（哪怕扩展名是 .png）都不认。 */
export function imageKind(b: Buffer): ImageKind | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
    return 'webp';
  return null;
}

/** git 的 blob 号（sha1 对象格式）：和远端树里的比。 */
export function gitBlobId(b: Buffer): string {
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Found {
  record: ShotFileRecord;
  kind: ImageKind;
  bytes: Buffer;
}

interface Collected {
  found: Found[];
  rejected: string[];
  /** 超了上限：算失败，树留着。 */
  over?: string;
}

const aborted = (t: UserTree) => t.signal?.aborted === true;

/** 清点 _tmp/shots：只列两层，不跟符号链接。_tmp 或 _tmp/shots 本身是链接就整个拒收。 */
async function collectTreeShots(t: UserTree, limits: ShotsLimits, out: Collected): Promise<void> {
  const script =
    'if [ -L _tmp ] || [ -L _tmp/shots ]; then exit 4; fi; [ -d _tmp/shots ] || exit 3; ' +
    "cd _tmp/shots && exec find . -mindepth 1 -maxdepth 2 -printf '%y %s %d %P\\0'";
  const r = await runInTree(t, [t.sh ?? SH, '-c', script, 'sh'], { timeoutMs: 60_000 });
  if (r.code === 3) return;
  if (r.code === 4) {
    out.rejected.push(`${SHOTS_DIR}：是符号链接，不跟`);
    return;
  }
  if (r.code !== 0) throw new Error(describeFailure(`清点 ${SHOTS_DIR}`, r));
  const candidates: { path: string; size: number }[] = [];
  for (const entry of r.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const m = /^(\S) (\d+) (\d) (.+)$/s.exec(entry);
    if (!m) continue;
    const [, type, size, depth, path] = m as unknown as [string, string, string, string, string];
    if (depth === '1' && type === 'd') {
      if (!LABEL.test(path)) out.rejected.push(`${path}/：标签名认不出，不看`);
      continue;
    }
    const [label, name] = path.split('/');
    if (type === 'l') out.rejected.push(`${path}：符号链接，不跟`);
    else if (depth === '1') out.rejected.push(`${path}：不在 <标签>/ 下，不看`);
    else if (type === 'd') out.rejected.push(`${path}/：子目录，不看`);
    else if (type !== 'f') out.rejected.push(`${path}：不是普通文件`);
    else if (!label || !name || !LABEL.test(label) || !IMAGE_NAME.test(name))
      out.rejected.push(`${path}：不是受管图片（只认 PNG/JPEG/WebP）`);
    else candidates.push({ path, size: Number(size) });
  }
  if (candidates.length > limits.maxFiles) {
    out.over = `${SHOTS_DIR} 里有 ${candidates.length} 张图，超过上限 ${limits.maxFiles}`;
    return;
  }
  for (const c of candidates) {
    if (c.size > limits.maxFileBytes) {
      out.over = `${c.path} 有 ${c.size} 字节，超过单张上限 ${limits.maxFileBytes}`;
      return;
    }
    // 读之前再核一遍：清点之后被换成链接的不读（只读到上限多一个字节，长大了也认得出）。标签目录单独传，不在 sh 里拆路径
    const read =
      'd="_tmp/shots/$1"; f="$d/$2"; ' +
      'if [ -L _tmp ] || [ -L _tmp/shots ] || [ -L "$d" ] || [ -L "$f" ] || [ ! -f "$f" ]; then exit 3; fi; ' +
      'exec head -c "$3" -- "$f"';
    const [label, name] = c.path.split('/') as [string, string];
    const got = await runInTree(t, [
      t.sh ?? SH,
      '-c',
      read,
      'sh',
      label,
      name,
      String(limits.maxFileBytes + 1),
    ]);
    if (got.code === 3) {
      out.rejected.push(`${c.path}：读的时候不在了或成了链接`);
      continue;
    }
    if (got.code !== 0) throw new Error(describeFailure(`读 ${SHOTS_DIR}/${c.path}`, got));
    const bytes = got.stdout;
    if (bytes.length > limits.maxFileBytes) {
      out.over = `${c.path} 超过单张上限 ${limits.maxFileBytes}`;
      return;
    }
    const kind = imageKind(bytes);
    if (!kind) {
      out.rejected.push(`${c.path}：文件头不是 PNG/JPEG/WebP`);
      continue;
    }
    out.found.push({
      record: {
        path: c.path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        blob: gitBlobId(bytes),
        from: 'tree',
      },
      kind,
      bytes,
    });
  }
}

/**
 * 树里没推的孤儿图片提交：git fsck 找不可达（不算 reflog）、没有父提交、树里全是受管图片的提交。
 * 树里没有 git 仓就没有；fsck 没跑成抛（没查成，不当成没有）。
 */
async function collectOrphanShots(t: UserTree, limits: ShotsLimits, out: Collected): Promise<void> {
  const isRepo = await runInTree(t, [t.git ?? GIT, 'rev-parse', '--git-dir']);
  if (isRepo.code !== 0) return;
  const fsck = await gitInTree(
    t,
    ['fsck', '--connectivity-only', '--unreachable', '--no-reflogs', '--no-progress'],
    '找没推的孤儿提交（git fsck）',
    { timeoutMs: 300_000 },
  );
  const unreachable = fsck.stdout
    .toString('utf8')
    .split('\n')
    .map((l) => /^unreachable commit ([0-9a-f]{40})$/.exec(l.trim())?.[1])
    .filter((s): s is string => s !== undefined)
    .slice(0, UNREACHABLE_SCAN_MAX);
  if (unreachable.length === 0) return;
  const parents = await gitInTree(
    t,
    ['log', '--no-walk=unsorted', '--format=%H %P', ...unreachable],
    '看孤儿提交有没有父提交',
  );
  const roots = parents.stdout
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => SHA.test(l));
  for (const commit of roots.slice(0, limits.maxOrphanCommits)) {
    const listed = await gitInTree(
      t,
      ['ls-tree', '-r', '-z', '-l', commit],
      `列孤儿提交 ${commit.slice(0, 7)}`,
    );
    const entries: { blob: string; size: number; path: string }[] = [];
    let images = true;
    for (const raw of listed.stdout.toString('utf8').split('\0').filter(Boolean)) {
      const m = /^(\d{6}) blob ([0-9a-f]{40}) +(\d+)\t(.+)$/s.exec(raw);
      const path = m?.[4] ?? '';
      const segs = path.split('/');
      if (!m?.[2] || !segs.every((seg) => LABEL.test(seg)) || !IMAGE_NAME.test(segs.at(-1) ?? '')) {
        images = false;
        break;
      }
      entries.push({ blob: m[2], size: Number(m[3]), path });
    }
    // 混着别的文件的不是图片提交，不归这里管
    if (!images || entries.length === 0) continue;
    for (const e of entries) {
      const path = `${commit.slice(0, 7)}/${e.path}`;
      if (out.found.length >= limits.maxFiles) {
        out.over = `受管图片超过上限 ${limits.maxFiles} 张（含孤儿提交 ${commit.slice(0, 7)}）`;
        return;
      }
      if (e.size > limits.maxFileBytes) {
        out.over = `孤儿提交里的 ${path} 有 ${e.size} 字节，超过单张上限 ${limits.maxFileBytes}`;
        return;
      }
      const blob = await gitInTree(t, ['cat-file', 'blob', e.blob], `读孤儿提交里的 ${path}`);
      const bytes = blob.stdout;
      const kind = imageKind(bytes);
      if (!kind) {
        out.rejected.push(`${path}：文件头不是 PNG/JPEG/WebP`);
        continue;
      }
      out.found.push({
        record: { path, bytes: bytes.length, sha256: sha256(bytes), blob: e.blob, from: commit },
        kind,
        bytes,
      });
    }
  }
}

/** 清点这棵树里的受管图片。 */
export async function collectShots(t: UserTree, limits: ShotsLimits = SHOTS_LIMITS): Promise<Collected> {
  const out: Collected = { found: [], rejected: [] };
  await collectTreeShots(t, limits, out);
  if (!out.over) await collectOrphanShots(t, limits, out);
  if (!out.over) {
    const total = uniqueBytes(out.found);
    if (total > limits.maxTotalBytes)
      out.over = `受管图片合计 ${total} 字节，超过上限 ${limits.maxTotalBytes}`;
  }
  return out;
}

function uniqueBytes(found: readonly Found[]): number {
  const seen = new Map<string, number>();
  for (const f of found) seen.set(f.record.sha256, f.record.bytes);
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

/**
 * 远端图片分支的树里有哪些 blob：镜像打的包（只含那一个孤儿提交）取进会话的树、挂在临时引用上列一遍，列完删引用。
 * 只看远端的东西：树里本地的提交不算。
 */
export async function blobsInBundle(
  t: UserTree,
  bundle: Buffer,
  ref: string,
  head: string,
): Promise<Set<string>> {
  if (!/^refs\/fleet\/[A-Za-z0-9/_.-]+$/.test(ref)) throw new Error(`bundle 里的引用名不对：${ref}`);
  const local = 'refs/fleet/shots-remote';
  const script =
    'f="$(git rev-parse --git-dir)/fleet-shots.bundle" && cat > "$f" && ' +
    'git fetch --no-tags -q "$f" "+$1:$2"; rc=$?; rm -f "$f"; exit $rc';
  const fetched = await runInTree(t, [t.sh ?? SH, '-c', script, 'sh', ref, local], {
    stdin: bundle,
    timeoutMs: 300_000,
  });
  if (fetched.code !== 0) throw new Error(describeFailure('取远端图片分支', fetched));
  try {
    const tip = (
      await gitInTree(t, ['rev-parse', '--verify', `${local}^{commit}`], '读远端图片分支头')
    ).stdout
      .toString('utf8')
      .trim();
    if (tip !== head)
      throw new Error(`取进来的远端图片分支头是 ${tip.slice(0, 7)}，不是 ${head.slice(0, 7)}`);
    const listed = await gitInTree(t, ['ls-tree', '-r', '-z', local], '列远端图片分支');
    const blobs = new Set<string>();
    for (const raw of listed.stdout.toString('utf8').split('\0')) {
      const m = /^\d{6} blob ([0-9a-f]{40})\t/.exec(raw);
      if (m?.[1]) blobs.add(m[1]);
    }
    return blobs;
  } finally {
    await runInTree(t, [t.git ?? GIT, 'update-ref', '-d', local]);
  }
}

export interface RemoteShots {
  /** null＝远端没有这个分支（404）。 */
  head: string | null;
  blobs: ReadonlySet<string>;
}

export interface PreserveShotsDeps {
  archiveDir: string;
  taskId: string;
  now: Date;
  /** 读远端图片分支：抛错算没读成（照样归档，原因写进 reason）。 */
  remote: (branch: string) => Promise<RemoteShots>;
  limits?: Partial<ShotsLimits>;
}

interface Manifest {
  schemaVersion: 1;
  taskId: string;
  issueNumber: number;
  at: string;
  delivery: ShotsDelivery;
}

/** 这个任务、这个代码头的归档目录。taskId、head 认不出就抛（不拼进路径）。 */
export function shotsArchiveDir(archiveDir: string, taskId: string, head: string): string {
  if (!TASK.test(taskId) || taskId.includes('..')) throw new Error(`任务号放不进目录名：${taskId}`);
  if (!SHA.test(head)) throw new Error(`代码头不是完整的提交号：${head}`);
  return join(archiveDir, taskId, 'shots', head);
}

/**
 * 收树前的那一步：清点受管图片 → 看远端读不读得到 → 读不到就存进受限归档。回结局；failed 时调用方不许删树。
 * 被叫停原样抛（树留着）。
 */
export async function preserveShots(
  t: UserTree,
  input: ShotsInput,
  deps: PreserveShotsDeps,
): Promise<ShotsDelivery> {
  const limits = { ...SHOTS_LIMITS, ...deps.limits };
  const branch = `shots/${input.issueNumber}`;
  const base = { head: input.head, branch };
  let dir: string;
  try {
    dir = shotsArchiveDir(deps.archiveDir, deps.taskId, input.head);
  } catch (error) {
    return { ...base, outcome: 'failed', files: [], reason: errMessage(error) };
  }
  const record = (delivery: ShotsDelivery) => writeRecord(dir, input, deps, delivery);

  let collected: Collected;
  try {
    collected = await collectShots(t, limits);
  } catch (error) {
    if (aborted(t)) throw error;
    return {
      ...base,
      outcome: 'failed',
      files: [],
      reason: `图片没清点成：${errMessage(error).slice(0, 200)}`,
    };
  }
  const files = collected.found.map((f) => f.record);
  const rejected = collected.rejected.slice(0, REJECTED_MAX);
  const extra = rejected.length > 0 ? { rejected } : {};
  if (collected.over) return { ...base, ...extra, outcome: 'failed', files, reason: collected.over };
  if (files.length === 0) return record({ ...base, ...extra, outcome: 'none', files });

  let remoteHead: string | null = null;
  let missing: string[];
  let reason: string;
  try {
    const remote = await deps.remote(branch);
    remoteHead = remote.head;
    missing = files.filter((f) => !remote.blobs.has(f.blob)).map((f) => f.path);
    reason =
      remote.head === null
        ? `远端没有 ${branch}（404），图片没交付`
        : `远端 ${branch} 缺 ${missing.length} 张`;
  } catch (error) {
    if (aborted(t)) throw error;
    missing = files.map((f) => f.path);
    reason = `远端 ${branch} 没读成：${errMessage(error).slice(0, 200)}`;
  }
  const seen = remoteHead ? { remoteHead } : {};
  if (remoteHead && missing.length === 0) {
    return record({ ...base, ...extra, ...seen, outcome: 'delivered', files });
  }
  const pending: ShotsDelivery = { ...base, ...extra, ...seen, outcome: 'archived', files, missing, reason };
  try {
    return await archiveShots(dir, input, deps, limits, collected.found, pending);
  } catch (error) {
    if (aborted(t)) throw error;
    return {
      ...pending,
      outcome: 'failed',
      reason: `${reason}；归档没成：${errMessage(error).slice(0, 200)}`,
    };
  }
}

/** 没有图片、已交付的也记一份清单（不存图）：树收了以后重试还说得清结局。记不成不碍事，原样回。 */
async function writeRecord(
  dir: string,
  input: ShotsInput,
  deps: PreserveShotsDeps,
  delivery: ShotsDelivery,
): Promise<ShotsDelivery> {
  const file = join(dir, 'manifest.json');
  const done = { ...delivery, archivedTo: file };
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(file, manifestJson(input, deps, done), { mode: 0o600 });
    return done;
  } catch {
    return delivery;
  }
}

function manifestJson(input: ShotsInput, deps: PreserveShotsDeps, delivery: ShotsDelivery): string {
  const m: Manifest = {
    schemaVersion: 1,
    taskId: deps.taskId,
    issueNumber: input.issueNumber,
    at: deps.now.toISOString(),
    delivery,
  };
  return `${JSON.stringify(m, null, 2)}\n`;
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    return m?.schemaVersion === 1 && m.delivery ? m : null;
  } catch {
    return null;
  }
}

const stored = (f: Found) => `${f.record.sha256}.${f.kind}`;

/** 同一个头已经存过、图片一张不差（文件在、hash 对）：不重写。 */
async function sameArchive(dir: string, found: readonly Found[]): Promise<Manifest | null> {
  const m = await readManifest(dir);
  if (m?.delivery.outcome !== 'archived') return null;
  const want = [...new Set(found.map((f) => f.record.sha256))].sort();
  const have = [...new Set(m.delivery.files.map((f) => f.sha256))].sort();
  if (want.join() !== have.join()) return null;
  for (const f of found) {
    try {
      if (sha256(await readFile(join(dir, stored(f)))) !== f.record.sha256) return null;
    } catch {
      return null;
    }
  }
  return m;
}

/** 归档里每个 <任务>/shots/<头>/：多大、什么时候记的。 */
async function archiveEntries(archiveDir: string): Promise<{ dir: string; bytes: number; at: number }[]> {
  const out: { dir: string; bytes: number; at: number }[] = [];
  let tasks: string[];
  try {
    tasks = await readdir(archiveDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw error;
  }
  for (const task of tasks) {
    const shots = join(archiveDir, task, 'shots');
    let heads: string[];
    try {
      heads = await readdir(shots);
    } catch {
      continue;
    }
    for (const head of heads) {
      const dir = join(shots, head);
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      let bytes = 0;
      for (const name of await readdir(dir)) bytes += (await stat(join(dir, name))).size;
      const m = await readManifest(dir);
      const at = m ? Date.parse(m.at) : info.mtimeMs;
      out.push({ dir, bytes, at: Number.isFinite(at) ? at : info.mtimeMs });
    }
  }
  return out;
}

/** 存图：先清过期的、算容量，放得下才写；写进临时目录、逐张核对 hash，再换上。 */
async function archiveShots(
  dir: string,
  input: ShotsInput,
  deps: PreserveShotsDeps,
  limits: ShotsLimits,
  found: readonly Found[],
  pending: ShotsDelivery,
): Promise<ShotsDelivery> {
  const manifestFile = join(dir, 'manifest.json');
  const reused = await sameArchive(dir, found);
  if (reused) return { ...pending, archivedTo: manifestFile };

  const cutoff = deps.now.getTime() - limits.keepDays * 24 * 3600 * 1000;
  let used = 0;
  for (const e of await archiveEntries(deps.archiveDir)) {
    if (e.dir === dir) continue;
    if (e.at < cutoff) {
      await rm(e.dir, { recursive: true, force: true });
      continue;
    }
    used += e.bytes;
  }
  const need = uniqueBytes(found);
  if (used + need > limits.archiveMaxBytes) {
    throw new Error(`图片归档满了：已用 ${used} 字节，再放 ${need} 字节超过上限 ${limits.archiveMaxBytes}`);
  }

  const parent = join(dir, '..');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.tmp-${randomUUID()}`);
  await mkdir(temp, { mode: 0o700 });
  try {
    for (const f of found) await writeFile(join(temp, stored(f)), f.bytes, { mode: 0o600, flag: 'w' });
    for (const f of found) {
      if (sha256(await readFile(join(temp, stored(f)))) !== f.record.sha256) {
        throw new Error(`存进去的 ${f.record.path} 读回来 hash 对不上`);
      }
    }
    const done: ShotsDelivery = { ...pending, archivedTo: manifestFile };
    await writeFile(join(temp, 'manifest.json'), manifestJson(input, deps, done), { mode: 0o600 });
    await rm(dir, { recursive: true, force: true });
    await rename(temp, dir);
    return done;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** 树已经收了（重试时）：按这个任务、这个头的清单说结局；没有清单就是 unknown，不当成没有图片。 */
export async function recordedShots(
  archiveDir: string,
  taskId: string,
  input: ShotsInput,
): Promise<ShotsDelivery> {
  const branch = `shots/${input.issueNumber}`;
  let dir: string;
  try {
    dir = shotsArchiveDir(archiveDir, taskId, input.head);
  } catch (error) {
    return { outcome: 'unknown', head: input.head, branch, files: [], reason: errMessage(error) };
  }
  const m = await readManifest(dir);
  if (m) return m.delivery;
  return {
    outcome: 'unknown',
    head: input.head,
    branch,
    files: [],
    reason: '工作树已经收了，没有图片核对记录，交没交付不知道',
  };
}
