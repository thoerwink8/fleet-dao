// 工作区是本机文件夹。是 git 仓才建工作树、才有 diff；forge 从 origin 的地址推。
// git 经 runCommand（runProcess）。这一层不自己起子进程。
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
