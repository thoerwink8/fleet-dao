// 归档回收的生产装配：把 GitHub 查提交、取 HEAD 树这两个真口子接给 real/archive-retention.ts。
//
// 只做装配，判据在 archive-retention.ts。两个口子都要「查不成就是 undefined」，让回收那边留着，
// 不许把查不成当成「不在远端」或「没有未提交内容」。
//
// 仓从哪来：归档不记仓名，所以把受管仓逐个试。
// 提交号是内容寻址的，同一个 HEAD 在哪个仓里都在，逐个试不会认错，只会多查几次（按 HEAD 缓存）。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoRef } from '@fleet-dao/github';
import type { ArchiveRetentionDeps } from './archive-retention.ts';

/** 回收要的 GitHub 口子：把提交抓进镜像。抓不到（不在远端）就是不在远端。 */
export interface ArchiveRetentionGitHub {
  /** 给不了就说明这个仓不归引擎管；回收那边按「查不成」留着。 */
  fetchCommitHead?: ((input: { repo: RepoRef; headSha: string }) => Promise<void>) | undefined;
}

export interface ArchiveRetentionWiringDeps {
  archiveDir: string;
  /** 受管仓（生产读库里 repos 表）。认不出归档属于哪个仓时逐个试。 */
  repos: () => Promise<readonly RepoRef[]>;
  gh: ArchiveRetentionGitHub;
  /** 引擎镜像裸仓的根；给了就先从镜像取 HEAD 树，取不到再退回归档自己的 bundle。 */
  mirrorRoot?: string;
  /** git 可执行文件，默认 'git'。 */
  gitBin?: string;
  now?: () => number;
}

/** 在临时目录里跑一个命令，拿 stdout。给了 input 就写进 stdin。 */
function run(
  cmd: string,
  args: string[],
  options: { input?: Buffer; cwd?: string } = {},
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', () => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? Buffer.alloc(0));
  });
}

/** git 认目录要 safe.directory；只给这一条，不动全局配置。 */
const GIT_SAFE = ['-c', 'safe.directory=*'];

/** 从一个 git 仓里取 HEAD 树每个文件的内容 sha256（路径 → sha256）。取不出返回 undefined。 */
async function readHeadTreeFromRepo(
  gitBin: string,
  repo: string,
  head: string,
): Promise<Map<string, string> | undefined> {
  const list = await run(gitBin, [...GIT_SAFE, '-C', repo, 'ls-tree', '-r', '-z', head]);
  if (list.code !== 0) return undefined;
  const tree = new Map<string, string>();
  for (const item of list.stdout.toString('utf8').split('\0')) {
    if (!item) continue;
    const tab = item.indexOf('\t');
    if (tab < 0) continue;
    const meta = item.slice(0, tab).split(' ');
    if (meta.length < 3 || meta[1] !== 'blob') continue;
    tree.set(item.slice(tab + 1), meta[2] as string);
  }
  if (tree.size === 0) return undefined;
  const shas = [...new Set(tree.values())].sort();
  const batch = await run(gitBin, [...GIT_SAFE, '-C', repo, 'cat-file', '--batch'], {
    input: Buffer.from(`${shas.join('\n')}\n`),
  });
  if (batch.code !== 0) return undefined;
  const bySha = new Map<string, string>();
  const data = batch.stdout;
  let idx = 0;
  for (let i = 0; i < shas.length; i += 1) {
    const nl = data.indexOf(0x0a, idx);
    if (nl < 0) return undefined;
    const header = data.subarray(idx, nl).toString('utf8').split(' ');
    if (header.length < 3) return undefined;
    const size = Number(header[2]);
    if (!Number.isInteger(size) || size < 0) return undefined;
    const body = data.subarray(nl + 1, nl + 1 + size);
    bySha.set(header[0] as string, createHash('sha256').update(body).digest('hex'));
    idx = nl + 1 + size + 1;
  }
  const out = new Map<string, string>();
  for (const [path, sha] of tree) {
    const digest = bySha.get(sha);
    if (digest === undefined) return undefined;
    out.set(path, digest);
  }
  return out;
}

/** 从归档自己的 recovery.bundle 取 HEAD 树（镜像里没有这个提交时退回这条路）。 */
async function readHeadTreeFromBundle(
  gitBin: string,
  head: string,
  bundle: string,
): Promise<Map<string, string> | undefined> {
  const tmp = await mkdtemp(join(tmpdir(), 'fleet-archive-gc-'));
  try {
    const repo = join(tmp, 'r');
    const clone = await run(gitBin, [...GIT_SAFE, 'clone', '-q', '--bare', bundle, repo]);
    if (clone.code !== 0) return undefined;
    return await readHeadTreeFromRepo(gitBin, repo, head);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** 记一个归档目录里 recovery.bundle 在不在（没有就退回不了，也就取不出树）。 */
async function hasBundle(dir: string): Promise<boolean> {
  try {
    const names = await readdir(dir);
    return names.includes('recovery.bundle');
  } catch {
    return false;
  }
}

/** 生产装配：给回收接上真口子。 */
export function createArchiveRetentionDeps(deps: ArchiveRetentionWiringDeps): ArchiveRetentionDeps {
  const gitBin = deps.gitBin ?? 'git';
  /** HEAD → 命中它的仓（逐个试出来的结果，按 HEAD 缓存，同一轮不重复查）。 */
  const repoOfHead = new Map<string, RepoRef>();
  return {
    archiveDir: deps.archiveDir,
    async isHeadPushed(head) {
      const known = repoOfHead.get(head);
      if (known) return true;
      const fetchCommitHead = deps.gh.fetchCommitHead;
      if (!fetchCommitHead) return undefined;
      let candidates: readonly RepoRef[];
      try {
        candidates = await deps.repos();
      } catch {
        return undefined;
      }
      let sawFailure = false;
      for (const repo of candidates) {
        try {
          await fetchCommitHead.call(deps.gh, { repo, headSha: head });
          repoOfHead.set(head, repo);
          return true;
        } catch (error) {
          // 404 / 「not our ref」= 这个仓没有它，接着试下一个仓。别的错（网络、限流）算查不成。
          const code = (error as { code?: unknown } | null)?.code;
          const status = (error as { status?: unknown } | null)?.status;
          if (
            code === 'NOT_FOUND' ||
            code === 'HEAD_NOT_FOUND' ||
            code === 'COMMIT_NOT_FOUND' ||
            status === 404
          ) {
            continue;
          }
          sawFailure = true;
        }
      }
      if (sawFailure) return undefined;
      return false;
    },
    async readHeadTree(head, bundle) {
      const repo = repoOfHead.get(head);
      if (repo && deps.mirrorRoot) {
        const mirror = join(deps.mirrorRoot, repo.owner.toLowerCase(), `${repo.name.toLowerCase()}.git`);
        const fromMirror = await readHeadTreeFromRepo(gitBin, mirror, head);
        if (fromMirror) return fromMirror;
      }
      if (!(await hasBundle(join(bundle, '..')))) return undefined;
      return readHeadTreeFromBundle(gitBin, head, bundle);
    },
    ...(deps.now ? { now: deps.now } : {}),
  };
}
