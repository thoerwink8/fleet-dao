// 工作区是本机文件夹。是 git 仓才建工作树、才有 diff；forge 从 origin 的地址推。
// git 经 runCommand（runProcess）。这一层不自己起子进程。
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { runCommand } from '../command.ts';

export type RepoForge = 'github' | 'gitlab' | 'local';

export function forgeOfRemote(remote: string | null): RepoForge {
  if (!remote) return 'local';
  const u = remote.toLowerCase();
  if (u.includes('github.com')) return 'github';
  if (u.includes('gitlab')) return 'gitlab';
  return 'local';
}

/** 必须是已有的文件夹，返回真实路径。 */
export async function existingDir(p: string): Promise<string> {
  const abs = resolve(p);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch {
    throw new Error('文件夹不存在');
  }
  if (!info.isDirectory()) throw new Error('不是文件夹');
  return realpath(abs);
}

const GIT_SAFE = [
  '-c',
  'safe.directory=*',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=off',
  '-c',
  'core.hooksPath=/dev/null',
];
const redact = makeRedactor([]);

function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return runCommand({
    command: ['git', ...GIT_SAFE, ...args],
    cwd,
    timeoutMs: 30_000,
    redact,
  }).then((r) => {
    if (!r.ran) return { code: 1, out: `${r.spawnError ?? r.killed ?? ''}\n${r.stderrTail}` };
    const err = r.exitCode === 0 ? '' : r.stderrTail;
    return { code: r.exitCode ?? 1, out: err ? `${r.stdout}\n${err}` : r.stdout };
  });
}

export async function inspectRepo(
  dir: string,
): Promise<{ isGit: boolean; remote: string | null; forge: RepoForge }> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.out.trim() !== 'true')
    return { isGit: false, remote: null, forge: 'local' };
  const remote = await git(dir, ['remote', 'get-url', 'origin']);
  const url = remote.code === 0 ? remote.out.trim() : null;
  return { isGit: true, remote: url || null, forge: forgeOfRemote(url) };
}

export async function addWorktree(repo: string, dest: string, branch: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const r = await git(repo, ['worktree', 'add', '-b', branch, dest]);
  if (r.code !== 0) throw new Error(`建工作树失败：${r.out.trim().slice(-300)}`);
}

/** 已跟踪文件的改动。未跟踪的文件不进补丁，状态行里仍能看见。 */
export async function worktreeDiff(
  cwd: string,
): Promise<{ git: boolean; status: string; diff: string; branch: string }> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.out.trim() !== 'true')
    return { git: false, status: '', diff: '', branch: '' };
  const status = await git(cwd, ['status', '--porcelain']);
  const unstaged = await git(cwd, ['diff', 'HEAD']);
  const staged = await git(cwd, ['diff', '--cached']);
  const diff = [unstaged.out, staged.code === 0 ? staged.out : ''].filter((s) => s.trim() !== '').join('\n');
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { git: true, status: status.out, diff, branch: branch.code === 0 ? branch.out.trim() : '' };
}

export type ChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflict'
  | 'typechange';

export interface GitFile {
  path: string;
  origPath?: string;
  staged: ChangeKind | null;
  unstaged: ChangeKind | null;
}

const KIND: Record<string, ChangeKind> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflict',
  '?': 'untracked',
};

/** `git status --porcelain=v1 -z`。重命名是两条路径，中间用 NUL 分开。 */
export function parsePorcelain(raw: string): GitFile[] {
  const parts = raw.split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i] ?? '';
    if (rec.length < 3) continue;
    const x = rec[0] ?? ' ';
    const y = rec[1] ?? ' ';
    const first = rec.slice(3);
    const renamed = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    let path = first;
    let origPath: string | undefined;
    if (renamed) {
      i += 1;
      origPath = first;
      path = parts[i] ?? first;
    }
    if (!path) continue;
    files.push({
      path,
      ...(origPath ? { origPath } : {}),
      staged: x === ' ' || x === '?' ? null : (KIND[x] ?? 'modified'),
      unstaged: y === ' ' ? null : (KIND[y] ?? 'modified'),
    });
  }
  return files;
}

/** 拒绝绝对路径和越出 cwd 的相对路径。返回 git 用的正斜杠路径。 */
export function assertInside(cwd: string, rel: string): string {
  if (rel === '' || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error('路径不对');
  }
  const root = resolve(cwd);
  const abs = resolve(cwd, rel);
  const out = relative(root, abs);
  if (out === '' || out.split(/[/\\]/).includes('..')) throw new Error('路径越出工作树');
  return rel.replaceAll('\\', '/');
}

export async function statusZ(cwd: string): Promise<string> {
  const r = await git(cwd, ['status', '--porcelain=v1', '-z']);
  if (r.code !== 0) throw new Error(r.out.trim().slice(-300) || '读状态没成');
  return r.out;
}

export async function branchInfo(cwd: string): Promise<{
  branch: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}> {
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = branch.code === 0 ? branch.out.trim() : '';
  const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up.code !== 0 || !up.out.trim()) return { branch: name, upstream: null, ahead: null, behind: null };
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
  const m = /^(\d+)\s+(\d+)/.exec(counts.out.trim());
  return {
    branch: name,
    upstream: up.out.trim(),
    ahead: m ? Number(m[1]) : null,
    behind: m ? Number(m[2]) : null,
  };
}

export async function stagePaths(cwd: string, paths: string[]): Promise<void> {
  const safe = paths.map((p) => assertInside(cwd, p));
  const r = await git(cwd, ['add', '--', ...safe]);
  if (r.code !== 0) throw new Error(r.out.trim().slice(-300) || '暂存没成');
}

export async function unstagePaths(cwd: string, paths: string[]): Promise<void> {
  const safe = paths.map((p) => assertInside(cwd, p));
  const r = await git(cwd, ['restore', '--staged', '--', ...safe]);
  if (r.code !== 0) throw new Error(r.out.trim().slice(-300) || '取消暂存没成');
}

export async function commitStaged(cwd: string, message: string): Promise<string> {
  const msg = message.trim();
  if (!msg) throw new Error('提交说明是空的');
  if (msg.length > 4000) throw new Error('提交说明太长');
  const quiet = await git(cwd, ['diff', '--cached', '--quiet']);
  if (quiet.code === 0) throw new Error('没有已暂存的改动');
  if (quiet.code !== 1) throw new Error(quiet.out.trim().slice(-300) || '看暂存没成');
  const r = await git(cwd, ['commit', '-m', msg]);
  if (r.code !== 0) throw new Error(r.out.trim().slice(-400) || '提交没成');
  const head = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return head.code === 0 ? head.out.trim() : '';
}

export async function pullFf(cwd: string): Promise<string> {
  const r = await git(cwd, ['pull', '--ff-only', '--no-rebase']);
  if (r.code !== 0) throw new Error(r.out.trim().slice(-400) || '拉取没成');
  return r.out.trim().slice(-400);
}

function capText(s: string): string {
  return s.length <= 80_000 ? s : `${s.slice(0, 80_000)}\n…截断`;
}

export async function fileDiffs(
  cwd: string,
  rel: string,
): Promise<{ path: string; staged: string; unstaged: string; untracked: string }> {
  const path = assertInside(cwd, rel);
  const staged = await git(cwd, ['diff', '--cached', '--', path]);
  const unstaged = await git(cwd, ['diff', '--', path]);
  let untracked = '';
  if (!staged.out.trim() && !unstaged.out.trim()) untracked = await untrackedPreview(cwd, path);
  return {
    path,
    staged: capText(staged.out),
    unstaged: capText(unstaged.out),
    untracked: capText(untracked),
  };
}

async function untrackedPreview(cwd: string, rel: string): Promise<string> {
  const abs = resolve(cwd, rel);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch {
    return '';
  }
  if (!info.isFile()) return '不是文件，不预览';
  if (info.size > 100_000) return '文件太大，不预览';
  const buf = await readFile(abs);
  if (buf.includes(0)) return '二进制文件，不预览';
  return buf
    .toString('utf8')
    .split('\n')
    .slice(0, 200)
    .map((line) => `+${line}`)
    .join('\n');
}

export interface ListedWorktree {
  path: string;
  head: string;
  branch: string;
}

export async function listWorktrees(repo: string): Promise<ListedWorktree[]> {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  const out: ListedWorktree[] = [];
  let cur: Partial<ListedWorktree> | null = null;
  const flush = () => {
    if (cur?.path && cur.head) out.push({ path: cur.path, head: cur.head, branch: cur.branch ?? '' });
    cur = null;
  };
  for (const line of r.out.split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ') && cur) cur.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached' && cur) cur.branch = '';
  }
  flush();
  return out;
}

export async function defaultBase(repo: string): Promise<string | null> {
  const sym = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.code === 0 && sym.out.trim()) return sym.out.trim();
  for (const c of ['origin/main', 'origin/master', 'main', 'master']) {
    const v = await git(repo, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]);
    if (v.code === 0 && v.out.trim()) return c;
  }
  return null;
}

export async function isAncestorOf(cwd: string, base: string): Promise<boolean> {
  const r = await git(cwd, ['merge-base', '--is-ancestor', 'HEAD', base]);
  return r.code === 0;
}

export async function isClean(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['status', '--porcelain']);
  return r.code === 0 && r.out.trim() === '';
}

/** 不带 --force。调用方先确认这棵树干净。 */
export async function removeWorktree(repo: string, target: string): Promise<void> {
  const r = await git(repo, ['worktree', 'remove', '--', target]);
  if (r.code !== 0) throw new Error(r.out.trim().slice(-400) || '删工作树没成');
}

export interface GhCheck {
  name: string;
  state: string;
}

export interface GhPr {
  number: number;
  url: string;
  state: string;
  checks: GhCheck[];
}

/** `gh pr view --json number,url,state,statusCheckRollup` 的正文。认不出就 null。 */
export function parseGhPr(json: unknown): GhPr | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (typeof o.number !== 'number') return null;
  const checks: GhCheck[] = [];
  if (Array.isArray(o.statusCheckRollup)) {
    for (const item of o.statusCheckRollup) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      const name = typeof c.name === 'string' ? c.name : typeof c.context === 'string' ? c.context : '检查';
      const state =
        typeof c.conclusion === 'string' && c.conclusion
          ? c.conclusion
          : typeof c.status === 'string'
            ? c.status
            : typeof c.state === 'string'
              ? c.state
              : 'unknown';
      checks.push({ name, state });
    }
  }
  return {
    number: o.number,
    url: typeof o.url === 'string' ? o.url : '',
    state: typeof o.state === 'string' ? o.state : '',
    checks,
  };
}
