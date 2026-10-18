// 界面验收图片收树前的交付核对和受限归档（#2983）。图片的约定见 docs/design/驾驶舱界面.md 第七节：存在树里的
// _tmp/shots/<标签>/<图>，推到远端 shots/<单号> 的孤儿提交。起因：#2969 合并成功就直接收树，_tmp/shots/2969 的 21 张图和
// 没推的孤儿提交跟着树一起没了，远端、镜像、任务归档都没有副本。
//
// 规矩：
// - 只碰受管的：_tmp/shots/<标签>/ 下一层的 PNG/JPEG/WebP（看文件头，不只认扩展名），和树里没有父提交、
//   里面只有这几种图片的孤儿提交。符号链接、层级不对、名字认不出、不是图片的一律拒收（列进 rejected，不存）；.env、凭据、
//   会话、日志、_tmp 别处一概不看。数量、单张、总量都有上限，超了算失败（树留着，不能默默丢）。
// - 交付按远端说话：远端 shots/<单号> 的树里有同样的 blob 号才算交付；本地文件、本地提交、文件非空都不算。引擎不推图片分支
//   （不新增权限，也就不会覆盖别的任务的分支）：没交付就存进受限归档，PR 说明里写明待交付。
// - 归档在 <归档>/<任务>/shots/<代码头>/：图片按 sha256 起名，manifest.json 记代码头、每张的路径、字节数、sha256、blob 号、
//   结局。同一任务同一个头重试：清单对得上就不重写；换了头另起目录；别的任务的目录只在过期时删。
// - 容量：所有任务的图片归档合计不超过 archiveMaxBytes；超过 keepDays 天的整目录删掉。删完还放不下就失败，树留着。
//   清过期、算容量、写入在同一把归档锁里（withArchiveLock），并发收树不会各自通过检查再一起超限。锁里记持有者令牌、
//   持有者定时续期（超过 10 分钟没续才当死锁接手）、释放只删自己的、不可逆的一步之前核对还持着锁；
//   已交付的清单也在这把锁里写，不会和同一个头的归档替换交错。
// - 看不全就失败：孤儿提交（无父提交、只含普通文件的图片）太多、不可达提交里的无父提交超过清点上限，一律算失败、树留着。
// - 已交付也要把清单（固定的头、清单、hash、结局）写下来，写不成算失败，不报已交付。
// - 删树的路不止收树一条：每小时对账的清扫和一键清理、建树前删同一位置的旧树、不带 shots 的收树都先过 keepShotsBeforeRemove，
//   回 failed 就不删。清扫不看远端，同一个头记过已交付才认，否则有图就归档。
// - 读树里的东西一律以会话用户的身份（user-git.ts 的 runInTree / gitInTree）：引擎不以自己的身份进会话的目录。

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
  /** 最多存几个没父提交的孤儿图片提交；多了算失败，不挑着存。 */
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
/** 树里无父提交最多逐个看多少个（引用可达和不可达合并去重）；再多算失败、树留着，不静默截断。 */
const ORPHAN_ROOT_SCAN_MAX = 200;
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
 * 树里没推的孤儿图片提交：本地引用可达和 fsck 找到的不可达根都查；本地引用不算交付。
 * 树里没有 git 仓就没有；fsck 没跑成抛（没查成，不当成没有）。
 */
async function collectOrphanShots(t: UserTree, limits: ShotsLimits, out: Collected): Promise<void> {
  if (!(await hasGitRepository(t))) return;
  const fsck = await gitInTree(
    t,
    ['fsck', '--connectivity-only', '--unreachable', '--no-reflogs', '--no-progress'],
    '找没推的孤儿提交（git fsck）',
    { timeoutMs: 300_000 },
  );
  const unreachable = [
    ...new Set(
      fsck.stdout
        .toString('utf8')
        .split('\n')
        .map((l) => /^unreachable commit ([0-9a-f]{40})$/.exec(l.trim())?.[1])
        .filter((s): s is string => s !== undefined),
    ),
  ];
  const reachable = await gitInTree(t, ['rev-list', '--all', '--max-parents=0'], '找本地引用里的无父提交', {
    timeoutMs: 300_000,
  });
  const roots = new Set<string>();
  for (const line of reachable.stdout.toString('utf8').split('\n').filter(Boolean)) {
    if (!SHA.test(line.trim())) throw new Error('本地引用的无父提交清单认不出');
    roots.add(line.trim());
  }
  // 提交号走标准输入（不受命令行长度限制），一个都不丢：看不全就不能说「没有别的孤儿图片提交」
  const parents =
    unreachable.length === 0
      ? null
      : await gitInTree(
          t,
          ['log', '--no-walk=unsorted', '--stdin', '--format=%H %P'],
          '看孤儿提交有没有父提交',
          { stdin: Buffer.from(`${unreachable.join('\n')}\n`), timeoutMs: 300_000 },
        );
  for (const line of parents?.stdout.toString('utf8').split('\n').filter(Boolean) ?? []) {
    const [commit, ...parentShas] = line.trim().split(/\s+/);
    // 没有父提交才算孤儿：后面带着任何父提交号的（哪怕自己不可达）不是
    if (!commit || !SHA.test(commit) || !parentShas.every((p) => SHA.test(p)))
      throw new Error('不可达提交的父提交清单认不出');
    if (parentShas.length === 0) roots.add(commit);
  }
  if (roots.size > ORPHAN_ROOT_SCAN_MAX) {
    out.over = `树里没推的无父提交有 ${roots.size} 个，超过清点上限 ${ORPHAN_ROOT_SCAN_MAX}，看不全，不删`;
    return;
  }
  let imageCommits = 0;
  for (const commit of roots) {
    const listed = await gitInTree(
      t,
      ['ls-tree', '-r', '-z', '-l', commit],
      `列孤儿提交 ${commit.slice(0, 7)}`,
    );
    const entries: { blob: string; size: number; path: string }[] = [];
    let images = true;
    for (const raw of listed.stdout.toString('utf8').split('\0').filter(Boolean)) {
      // 只认普通文件（100644 / 100755）：120000 符号链接、160000 子模块的 blob 不是图片
      const m = /^(100644|100755) blob ([0-9a-f]{40}) +(\d+)\t(.+)$/s.exec(raw);
      const path = m?.[4] ?? '';
      const segs = path.split('/');
      if (
        !m?.[2] ||
        !segs.slice(0, -1).every((seg) => LABEL.test(seg)) ||
        !IMAGE_NAME.test(segs.at(-1) ?? '')
      ) {
        images = false;
        break;
      }
      entries.push({ blob: m[2], size: Number(m[3]), path });
    }
    // 混着别的文件的不是图片提交，不归这里管
    if (!images || entries.length === 0) continue;
    imageCommits += 1;
    if (imageCommits > limits.maxOrphanCommits) {
      out.over = `没推的孤儿图片提交超过 ${limits.maxOrphanCommits} 个，看不全，不删`;
      return;
    }
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

/** 存清单、存图用到的那几样（不含读远端）。 */
type ArchiveDeps = Omit<PreserveShotsDeps, 'remote'>;

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
  const base = { head: input.head, branch: `shots/${input.issueNumber}` };
  try {
    shotsArchiveDir(deps.archiveDir, deps.taskId, input.head);
  } catch (error) {
    return { ...base, outcome: 'failed', files: [], reason: errMessage(error) };
  }
  const collected = await collectOrFail(t, limits);
  if ('reason' in collected) return { ...base, outcome: 'failed', files: [], reason: collected.reason };
  return settleShots(t, collected, input, deps, limits, { recordNone: true, remote: deps.remote });
}

export interface KeepShotsOptions extends ArchiveDeps {
  /** 认不出是哪张单（分支名不是 fleet/<号>-…）就不带：不看远端，有图直接归档。 */
  issueNumber?: number;
  /** 固定的代码头；不给就读树的 HEAD，树不是仓（或还没有提交）就按图片内容起一个号。 */
  head?: string;
  /** 不给就不看远端：同一个头有「已交付」的核对记录、图一张不差才认交付，否则一律归档。 */
  remote?: PreserveShotsDeps['remote'];
}

/**
 * 删树的别的路（每小时对账的清扫和一键清理、建树前删同位置的旧树、不带 shots 的收树）共用的那一道：
 * 树里没有受管图片就回 none、不记清单（清扫每棵树都过一遍，不留一堆空清单）；有图就和收树时一样核对远端 / 存进受限归档。
 * 回 failed 时调用方不许删树。被叫停原样抛。
 */
export async function keepShotsBeforeRemove(t: UserTree, opts: KeepShotsOptions): Promise<ShotsDelivery> {
  const limits = { ...SHOTS_LIMITS, ...opts.limits };
  const branch = opts.issueNumber === undefined ? 'shots/?' : `shots/${opts.issueNumber}`;
  const head0 = opts.head ?? '';
  const collected = await collectOrFail(t, limits);
  if ('reason' in collected) {
    return { head: head0, branch, outcome: 'failed', files: [], reason: collected.reason };
  }
  if (collected.found.length === 0 && !collected.over) {
    const rejected = collected.rejected.slice(0, REJECTED_MAX);
    return { head: head0, branch, outcome: 'none', files: [], ...(rejected.length > 0 ? { rejected } : {}) };
  }
  const files = collected.found.map((f) => f.record);
  let head = opts.head;
  if (head === undefined) {
    try {
      head = (await treeHead(t)) ?? contentHead(collected.found);
    } catch (error) {
      if (aborted(t)) throw error;
      return {
        head: '',
        branch,
        outcome: 'failed',
        files,
        reason: `读不出树的头：${errMessage(error).slice(0, 200)}`,
      };
    }
  }
  try {
    shotsArchiveDir(opts.archiveDir, opts.taskId, head);
  } catch (error) {
    return { head, branch, outcome: 'failed', files, reason: errMessage(error) };
  }
  const deps: ArchiveDeps = { archiveDir: opts.archiveDir, taskId: opts.taskId, now: opts.now };
  const issueNumber = opts.issueNumber;
  const settled = await settleShots(t, collected, { issueNumber: issueNumber ?? 0, head }, deps, limits, {
    recordNone: false,
    remote: issueNumber === undefined ? undefined : opts.remote,
  });
  return { ...settled, branch };
}

/** 清点；没清点成回原因（不抛，叫停照抛）。 */
async function collectOrFail(t: UserTree, limits: ShotsLimits): Promise<Collected | { reason: string }> {
  // 叫停了不清点：不靠杀子进程抢在它跑完之前（小目录一眨眼就列完了）
  t.signal?.throwIfAborted();
  let collected: Collected;
  try {
    collected = await collectShots(t, limits);
  } catch (error) {
    if (aborted(t)) throw error;
    return { reason: `图片没清点成：${errMessage(error).slice(0, 200)}` };
  }
  t.signal?.throwIfAborted();
  return collected;
}

/** 树的 HEAD；不是 git 仓、或还没有提交回 null。 */
async function treeHead(t: UserTree): Promise<string | null> {
  if (!(await hasGitRepository(t))) return null;
  const r = await runInTree(t, [t.git ?? GIT, 'rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const head = r.stdout.toString('utf8').trim();
  if (r.code === 0 && SHA.test(head)) return head;
  if (r.code === 1 && !r.stderr.trim() && !r.timedOut && !r.aborted && !r.spawnError) return null;
  throw new Error(describeFailure('读图片工作树的代码头', r));
}

/** 仅 Git 明确报告不在仓内才算没有；坏配置、权限、超时都必须挡住删树。runInTree 固定 C locale。 */
async function hasGitRepository(t: UserTree): Promise<boolean> {
  const r = await runInTree(t, [t.git ?? GIT, 'rev-parse', '--git-dir']);
  if (r.code === 0 && !r.timedOut && !r.aborted && !r.spawnError) return true;
  if (
    r.code === 128 &&
    !r.timedOut &&
    !r.aborted &&
    !r.spawnError &&
    /^fatal: not a git repository(?: \(or any of the parent directories\))?:[^\r\n]*$/.test(r.stderr.trim())
  )
    return false;
  throw new Error(describeFailure('探测图片工作树的 Git 仓', r));
}

/** 没有代码头时按图片内容起的号（40 位）：同样的一批图重试落进同一个目录。 */
function contentHead(found: readonly Found[]): string {
  const list = [...new Set(found.map((f) => f.record.sha256))].sort().join(',');
  return createHash('sha1').update(`fleet-shots:${list}`).digest('hex');
}

/**
 * 清点完的那一半：远端读得到就算交付，读不到就归档。recordNone＝没有图也记一份清单（收树时记，重试说得清结局）。
 * 没给 remote（不看远端）：同一个头的核对记录说已交付、图一张不差才认交付，否则归档。
 */
async function settleShots(
  t: UserTree,
  collected: Collected,
  input: ShotsInput,
  deps: ArchiveDeps,
  limits: ShotsLimits,
  how: { recordNone: boolean; remote: PreserveShotsDeps['remote'] | undefined },
): Promise<ShotsDelivery> {
  const branch = `shots/${input.issueNumber}`;
  const base = { head: input.head, branch };
  const dir = shotsArchiveDir(deps.archiveDir, deps.taskId, input.head);
  const record = (delivery: ShotsDelivery) => writeRecord(dir, input, deps, delivery, t);
  const files = collected.found.map((f) => f.record);
  const rejected = collected.rejected.slice(0, REJECTED_MAX);
  const extra = rejected.length > 0 ? { rejected } : {};
  if (collected.over) return { ...base, ...extra, outcome: 'failed', files, reason: collected.over };
  if (files.length === 0) {
    const none: ShotsDelivery = { ...base, ...extra, outcome: 'none', files };
    return how.recordNone ? record(none) : none;
  }

  let remoteHead: string | null = null;
  let missing: string[];
  let reason: string;
  if (!how.remote) {
    const before = await readManifest(dir);
    if (before && validManifest(before, deps.taskId, input) && before.delivery.outcome === 'delivered') {
      const delivered = new Set(before.delivery.files.map((f) => f.blob));
      if (files.every((f) => delivered.has(f.blob))) {
        return { ...before.delivery, archivedTo: join(dir, 'manifest.json') };
      }
    }
    missing = files.map((f) => f.path);
    reason = '删树前没核对远端，也没有已交付的核对记录：图片存进归档，待交付';
  } else {
    try {
      const remote = await how.remote(branch);
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
  }
  const seen = remoteHead ? { remoteHead } : {};
  if (remoteHead && missing.length === 0) {
    return record({ ...base, ...extra, ...seen, outcome: 'delivered', files });
  }
  const pending: ShotsDelivery = { ...base, ...extra, ...seen, outcome: 'archived', files, missing, reason };
  t.signal?.throwIfAborted();
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

/**
 * 没有图片、已交付的也记一份清单（不存图）：树收了以后重试还说得清结局。
 * 没有图片时记不成不碍事，原样回；已交付记不成就回 failed 并写明原因（调用方不删树）：固定的头、清单、hash 和结局
 * 没持久记下来，就不能说「已交付、可以收树」。
 */
async function writeRecord(
  dir: string,
  input: ShotsInput,
  deps: ArchiveDeps,
  delivery: ShotsDelivery,
  t: UserTree,
): Promise<ShotsDelivery> {
  const file = join(dir, 'manifest.json');
  const done = { ...delivery, archivedTo: file };
  const temp = join(dir, `.manifest-${randomUUID()}.tmp`);
  try {
    // 和归档替换同一把锁：不会和同一个头的 rm + rename 交错，写下的清单不会被换掉目录时带走
    await withArchiveLock(deps.archiveDir, async (held) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temp, manifestJson(input, deps, done), { mode: 0o600 });
      await held();
      await rename(temp, file);
    });
    return done;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (aborted(t)) throw error;
    if (delivery.outcome !== 'delivered') return delivery;
    return {
      ...delivery,
      outcome: 'failed',
      reason: `远端已有这些图，但交付清单没写成：${errMessage(error).slice(0, 200)}`,
    };
  }
}

function manifestJson(input: ShotsInput, deps: ArchiveDeps, delivery: ShotsDelivery): string {
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
    const m = JSON.parse(
      (await readBoundedFile(dir, 'manifest.json', 1024 * 1024)).toString('utf8'),
    ) as Manifest;
    return m?.schemaVersion === 1 && m.delivery ? m : null;
  } catch {
    return null;
  }
}

/** 先核普通文件、再按上限读；拒绝链接、目录和读的时候被换掉/长大的文件。 */
async function readBoundedFile(dir: string, name: string, maxBytes: number): Promise<Buffer> {
  if (!(await lstat(dir)).isDirectory()) throw new Error('归档目录不是普通目录');
  const file = join(dir, name);
  const before = await lstat(file);
  if (!before.isFile() || before.size > maxBytes) throw new Error(`${name} 不是受限的普通文件`);
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > maxBytes || info.dev !== before.dev || info.ino !== before.ino)
      throw new Error(`${name} 读前被换掉或超过上限`);
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const read = await fd.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await fd.stat();
    const pathInfo = await lstat(file);
    if (
      length !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      !pathInfo.isFile() ||
      pathInfo.dev !== info.dev ||
      pathInfo.ino !== info.ino
    )
      throw new Error(`${name} 读取时变了`);
    return buffer.subarray(0, length);
  } finally {
    await fd.close();
  }
}

/** 清单只作证据：身份、数量和用于寻址/核对的字段都要认得出。 */
function validManifest(m: Manifest, taskId: string, input: ShotsInput): boolean {
  const d = m.delivery;
  const strings = (value: unknown, max: number) =>
    Array.isArray(value) && value.length <= max && value.every((s) => typeof s === 'string');
  if (
    m.taskId !== taskId ||
    m.issueNumber !== input.issueNumber ||
    !d ||
    d.head !== input.head ||
    d.branch !== `shots/${input.issueNumber}` ||
    !['none', 'delivered', 'archived', 'failed', 'unknown'].includes(d.outcome) ||
    !Array.isArray(d.files) ||
    d.files.length > SHOTS_LIMITS.maxFiles
  )
    return false;
  if (
    (d.remoteHead !== undefined && (typeof d.remoteHead !== 'string' || !SHA.test(d.remoteHead))) ||
    (d.archivedTo !== undefined && typeof d.archivedTo !== 'string') ||
    (d.reason !== undefined && typeof d.reason !== 'string') ||
    (d.missing !== undefined && !strings(d.missing, SHOTS_LIMITS.maxFiles)) ||
    (d.rejected !== undefined && !strings(d.rejected, REJECTED_MAX))
  )
    return false;
  if (
    (d.outcome === 'none' && d.files.length !== 0) ||
    ((d.outcome === 'archived' || d.outcome === 'delivered') && d.files.length === 0)
  )
    return false;
  const unique = new Map<string, ShotFileRecord>();
  for (const f of d.files) {
    if (
      !f ||
      typeof f.path !== 'string' ||
      f.path.length > 4096 ||
      !f.path
        .split('/')
        .slice(0, -1)
        .every((s) => LABEL.test(s)) ||
      !IMAGE_NAME.test(f.path.split('/').at(-1) ?? '') ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes <= 0 ||
      f.bytes > SHOTS_LIMITS.maxFileBytes ||
      typeof f.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(f.sha256) ||
      typeof f.blob !== 'string' ||
      !SHA.test(f.blob) ||
      (f.from !== 'tree' && (typeof f.from !== 'string' || !SHA.test(f.from)))
    )
      return false;
    const previous = unique.get(f.sha256);
    if (previous && (previous.bytes !== f.bytes || previous.blob !== f.blob)) return false;
    unique.set(f.sha256, f);
  }
  return [...unique.values()].reduce((total, f) => total + f.bytes, 0) <= SHOTS_LIMITS.maxTotalBytes;
}

/** 旧清单没记 kind：只试固定的三种后缀，实际字节决定种类，不按原文件名猜。 */
async function verifyArchive(dir: string, files: readonly ShotFileRecord[]): Promise<void> {
  const checked = new Set<string>();
  for (const f of files) {
    if (checked.has(f.sha256)) continue;
    checked.add(f.sha256);
    let verified = false;
    for (const kind of ['png', 'jpeg', 'webp'] as const) {
      try {
        const bytes = await readBoundedFile(dir, `${f.sha256}.${kind}`, SHOTS_LIMITS.maxFileBytes);
        if (
          bytes.length === f.bytes &&
          sha256(bytes) === f.sha256 &&
          gitBlobId(bytes) === f.blob &&
          imageKind(bytes) === kind
        )
          verified = true;
      } catch {
        // 另一个固定后缀可能才是实际字节种类；三个都没核过才失败。
      }
      if (verified) break;
    }
    if (!verified) throw new Error(`归档图片 ${f.path} 缺失、损坏或不是受限普通文件`);
  }
}

const stored = (f: Found) => `${f.record.sha256}.${f.kind}`;

/** 同一个头已经存过、图片一张不差（文件在、hash 对）：不重写。 */
async function sameArchive(
  dir: string,
  found: readonly Found[],
  taskId: string,
  input: ShotsInput,
): Promise<Manifest | null> {
  const m = await readManifest(dir);
  if (!m || !validManifest(m, taskId, input) || m.delivery.outcome !== 'archived') return null;
  const want = [...new Set(found.map((f) => f.record.sha256))].sort();
  const have = [...new Set(m.delivery.files.map((f) => f.sha256))].sort();
  if (want.join() !== have.join()) return null;
  try {
    await verifyArchive(dir, m.delivery.files);
  } catch {
    return null;
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

/** 同一个进程里同一份归档的收树排队（key＝归档目录）。 */
const archiveQueues = new Map<string, Promise<unknown>>();
const LOCK_NAME = '.shots.lock';
const LOCK_WAIT_MS = 60_000;
/** 超过这么久没续期的锁当成持锁的进程死了，可以接手。持锁的进程每 LOCK_BEAT_MS 续一次期，所以活着的不会被当成死锁。 */
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_BEAT_MS = 30_000;
const LOCK_OWNER = 'owner';

/** 持锁期间交给 fn 的核对：锁被别人接手了（进程冻住太久、锁目录被清）就抛，调用方在不可逆的一步之前调。 */
type HeldCheck = () => Promise<void>;

/**
 * 容量检查和写入之间的互斥（决定容量上限不被并发收树冲破）：进程内按归档目录排队，跨进程靠归档目录下的锁目录
 * （mkdir 原子；锁里记持有者的令牌，持有者定时续期，只有超过 LOCK_STALE_MS 没续的才被接手，释放只删自己的锁）。
 * 等不到锁抛错，调用方当归档没成、树留着。
 */
async function withArchiveLock<T>(archiveDir: string, fn: (held: HeldCheck) => Promise<T>): Promise<T> {
  const prev = archiveQueues.get(archiveDir) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => withDirLock(archiveDir, fn));
  archiveQueues.set(archiveDir, run);
  try {
    return await run;
  } finally {
    if (archiveQueues.get(archiveDir) === run) archiveQueues.delete(archiveDir);
  }
}

const readOwner = (lock: string) => readFile(join(lock, LOCK_OWNER), 'utf8').catch(() => null);

async function withDirLock<T>(archiveDir: string, fn: (held: HeldCheck) => Promise<T>): Promise<T> {
  await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const lock = join(archiveDir, LOCK_NAME);
  const token = randomUUID();
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        await writeFile(join(lock, LOCK_OWNER), token, { mode: 0o600 });
      } catch (error) {
        // 目录是自己建的、令牌没写成：撤掉，别留个没主的锁
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const seen = await readOwner(lock);
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS && (await readOwner(lock)) === seen) {
        // 接手：先改名再删，不碰这期间别人新建的同名锁（改名成功的只有一个）
        const dead = `${lock}.stale-${randomUUID()}`;
        await rename(lock, dead).then(
          () => rm(dead, { recursive: true, force: true }),
          () => undefined,
        );
        continue;
      }
      if (Date.now() > until) throw new Error('等归档的锁等了太久，别的收树还占着');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const held: HeldCheck = async () => {
    if ((await readOwner(lock)) !== token) throw new Error('归档的锁被别的进程接手了，这次不写');
  };
  const beat = setInterval(() => {
    void held().then(
      () => utimes(lock, new Date(), new Date()),
      () => undefined,
    );
  }, LOCK_BEAT_MS);
  beat.unref();
  try {
    return await fn(held);
  } finally {
    clearInterval(beat);
    // 只删自己的：被接手后锁是别人的了
    if ((await readOwner(lock)) === token) await rm(lock, { recursive: true, force: true });
  }
}

/** 存图：整段（清过期、算容量、写入）在归档锁里，并发收树不会同时通过容量检查。 */
function archiveShots(
  dir: string,
  input: ShotsInput,
  deps: ArchiveDeps,
  limits: ShotsLimits,
  found: readonly Found[],
  pending: ShotsDelivery,
): Promise<ShotsDelivery> {
  return withArchiveLock(deps.archiveDir, (held) =>
    archiveShotsLocked(dir, input, deps, limits, found, pending, held),
  );
}

/** 存图：先清过期的、算容量，放得下才写；写进临时目录、逐张核对 hash，再换上。 */
async function archiveShotsLocked(
  dir: string,
  input: ShotsInput,
  deps: ArchiveDeps,
  limits: ShotsLimits,
  found: readonly Found[],
  pending: ShotsDelivery,
  held: HeldCheck,
): Promise<ShotsDelivery> {
  const manifestFile = join(dir, 'manifest.json');
  const reused = await sameArchive(dir, found, deps.taskId, input);
  if (reused) return { ...pending, archivedTo: manifestFile };

  const cutoff = deps.now.getTime() - limits.keepDays * 24 * 3600 * 1000;
  let used = 0;
  for (const e of await archiveEntries(deps.archiveDir)) {
    if (e.dir === dir) continue;
    if (e.at < cutoff) {
      await held();
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
    await held();
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
  if (m && validManifest(m, taskId, input)) {
    if (m.delivery.outcome !== 'archived') return m.delivery;
    try {
      await verifyArchive(dir, m.delivery.files);
      return m.delivery;
    } catch (error) {
      return { ...m.delivery, outcome: 'unknown', reason: `工作树已经收了，${errMessage(error)}` };
    }
  }
  return {
    outcome: 'unknown',
    head: input.head,
    branch,
    files: [],
    reason: '工作树已经收了，没有有效且身份一致的图片核对记录，交没交付不知道',
  };
}
