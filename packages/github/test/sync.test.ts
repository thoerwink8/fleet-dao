// 并主线：用真 git、本地裸仓当远端（不出网）。GitHub 接口（默认分支、换令牌）走假服务，和 push.test.ts 一样。
// 这里不需要会话打包：分支本来就已经在远端（对应一张开着的 PR），syncMainline 直接在镜像里 fetch/merge/push。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { execGit, type GitRunner } from '../src/git.ts';
import { repo, setup } from './helpers.ts';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...ID, '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let root: string;
let remote: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-gh-sync-'));
  remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
}, 60_000);

/** 从远端此刻的 main 切一个任务分支、写一个文件、提交、推上去（模拟已经开着的 PR 分支）。 */
function makeBranch(branch: string, file: string, content: string): { path: string; head: string } {
  const path = join(root, `wt-${branch.replace(/\//g, '-')}-${Math.random().toString(36).slice(2, 7)}`);
  git(root, 'clone', '-q', '-b', 'main', remote, path);
  git(path, 'checkout', '-q', '-b', branch);
  writeFileSync(join(path, file), content);
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', `work on ${branch}`);
  git(path, 'push', '-q', 'origin', `HEAD:${branch}`);
  return { path, head: git(path, 'rev-parse', 'HEAD') };
}

/** 单独起一个克隆，在远端 main 上加一个提交、推上去（模拟主线前进），回新的 main 头。 */
function advanceMain(file: string, content: string): string {
  const tmp = join(root, `adv-${Math.random().toString(36).slice(2, 7)}`);
  git(root, 'clone', '-q', remote, tmp);
  writeFileSync(join(tmp, file), content);
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 'main moves');
  git(tmp, 'push', '-q', 'origin', 'HEAD:main');
  return git(tmp, 'rev-parse', 'HEAD');
}

function remoteHead(branch: string): string | null {
  const out = git(root, 'ls-remote', remote, `refs/heads/${branch}`);
  return out ? (out.split('\t')[0] ?? null) : null;
}

/** 直接查裸仓（本地路径）里一个提交的父提交号，顺序和 `commit-tree -p a -p b` 一致。 */
function parentsOf(sha: string): string[] {
  return git(remote, 'rev-list', '--parents', '-n', '1', sha).split(/\s+/).slice(1);
}

function syncSetup(runner?: GitRunner) {
  return setup({
    git: runner ?? execGit,
    gitUrl: () => remote,
    gitHost: 'https://github.com/',
    env: {},
  });
}

describe('并主线', { timeout: 60_000 }, () => {
  it('干净并：生成的合并提交两个父提交对，远端读回也对', async () => {
    const { gh } = syncSetup();
    const branch = makeBranch('task/1-clean', 'b.txt', 'feature\n');
    const mainline = advanceMain('a.txt', 'main moves\n');
    const res = await gh.syncMainline({ repo, prNumber: 1, branch: 'task/1-clean', head: branch.head });
    if (res.state !== 'clean') throw new Error(`期望 clean，实际 ${res.state}`);
    expect(res).toMatchObject({ merged: true, previousHead: branch.head, mainline });
    expect(res.head).not.toBe(branch.head);
    expect(remoteHead('task/1-clean')).toBe(res.head);
    expect(parentsOf(res.head)).toEqual([branch.head, mainline]);
  });

  it('本来就含最新主线：不用并，头不变', async () => {
    const { gh } = syncSetup();
    const mainline = advanceMain('c.txt', 'advance-before-branch\n');
    const branch = makeBranch('task/2-uptodate', 'd.txt', 'feature\n');
    const res = await gh.syncMainline({ repo, prNumber: 2, branch: 'task/2-uptodate', head: branch.head });
    expect(res).toEqual({
      state: 'clean',
      merged: false,
      head: branch.head,
      previousHead: branch.head,
      mainline,
    });
    expect(remoteHead('task/2-uptodate')).toBe(branch.head);
  });

  it('冲突：回冲突文件清单，远端分支没被动', async () => {
    const { gh } = syncSetup();
    const branch = makeBranch('task/3-conflict', 'README.md', 'from branch\n');
    const mainline = advanceMain('README.md', 'from main\n');
    const res = await gh.syncMainline({ repo, prNumber: 3, branch: 'task/3-conflict', head: branch.head });
    expect(res).toEqual({
      state: 'conflict',
      head: branch.head,
      conflictFiles: ['README.md'],
      mainline,
    });
    expect(remoteHead('task/3-conflict')).toBe(branch.head);
  });

  it('远端分支头被人推过：报出新头，什么都没做', async () => {
    const { gh } = syncSetup();
    const branch = makeBranch('task/4-moved', 'e.txt', 'mine\n');
    writeFileSync(join(branch.path, 'e2.txt'), 'theirs\n');
    git(branch.path, 'add', '-A');
    git(branch.path, 'commit', '-q', '-m', 'someone else');
    git(branch.path, 'push', '-q', 'origin', 'HEAD:task/4-moved');
    const theirs = git(branch.path, 'rev-parse', 'HEAD');
    const res = await gh.syncMainline({ repo, prNumber: 4, branch: 'task/4-moved', head: branch.head });
    expect(res).toEqual({ state: 'head_moved', head: theirs, expectedHead: branch.head });
    expect(remoteHead('task/4-moved')).toBe(theirs);
  });

  it('重试：远端头正是自己上次推的并主线提交，认出来当成功、不再推第二次', async () => {
    const { gh } = syncSetup();
    const branch = makeBranch('task/5-retry', 'f.txt', 'feature\n');
    const mainline = advanceMain('g.txt', 'advance\n');
    const first = await gh.syncMainline({ repo, prNumber: 5, branch: 'task/5-retry', head: branch.head });
    if (first.state !== 'clean' || !first.merged) throw new Error('测试假设：第一次应该并成功');
    const retry = await gh.syncMainline({ repo, prNumber: 5, branch: 'task/5-retry', head: branch.head });
    expect(retry).toEqual({
      state: 'clean',
      merged: true,
      head: first.head,
      previousHead: branch.head,
      mainline,
    });
    expect(remoteHead('task/5-retry')).toBe(first.head);
  });

  it('推被拒——非快进：认不出是自己的重试，报可重试的 PUSH_RACE', async () => {
    const runner: GitRunner = async (args, call) =>
      args[0] === 'push'
        ? { code: 1, stdout: '', stderr: ' ! [rejected]  x -> task/6-race (fetch first)' }
        : execGit(args, call);
    const { gh } = syncSetup(runner);
    const branch = makeBranch('task/6-race', 'h.txt', 'feature\n');
    advanceMain('i.txt', 'advance\n');
    await expect(
      gh.syncMainline({ repo, prNumber: 6, branch: 'task/6-race', head: branch.head }),
    ).rejects.toMatchObject({ code: 'PUSH_RACE', retryable: true });
    expect(remoteHead('task/6-race')).toBe(branch.head);
  });

  it('推被拒——workflows 权限：一次判定要人，不可重试', async () => {
    const stderr =
      'remote: error: GH013 ...\n ! [remote rejected] abc -> task/7-wf (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\nerror: failed to push some refs';
    const runner: GitRunner = async (args, call) =>
      args[0] === 'push' ? { code: 1, stdout: '', stderr } : execGit(args, call);
    const { gh } = syncSetup(runner);
    const branch = makeBranch('task/7-wf', 'j.txt', 'feature\n');
    advanceMain('k.txt', 'advance\n');
    await expect(
      gh.syncMainline({ repo, prNumber: 7, branch: 'task/7-wf', head: branch.head }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_PERMISSION', retryable: false });
    expect(remoteHead('task/7-wf')).toBe(branch.head);
  });

  it('抓取主线与分支失败（网络类）：报 GIT_FAILED，可重试，远端分支没被动', async () => {
    const runner: GitRunner = async (args, call) =>
      args[0] === 'fetch'
        ? { code: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.test' }
        : execGit(args, call);
    const { gh } = syncSetup(runner);
    const branch = makeBranch('task/9-fetch-fail', 'n.txt', 'feature\n');
    advanceMain('o.txt', 'advance\n');
    await expect(
      gh.syncMainline({ repo, prNumber: 9, branch: 'task/9-fetch-fail', head: branch.head }),
    ).rejects.toMatchObject({ code: 'GIT_FAILED', retryable: true });
    expect(remoteHead('task/9-fetch-fail')).toBe(branch.head);
  });

  it('git 版本太旧：merge-tree 用不了，报 GIT_TOO_OLD，什么都没推', async () => {
    const runner: GitRunner = async (args, call) =>
      args[0] === '--version' ? { code: 0, stdout: 'git version 2.30.0\n', stderr: '' } : execGit(args, call);
    const { gh } = syncSetup(runner);
    const branch = makeBranch('task/8-old-git', 'l.txt', 'feature\n');
    advanceMain('m.txt', 'advance\n');
    await expect(
      gh.syncMainline({ repo, prNumber: 8, branch: 'task/8-old-git', head: branch.head }),
    ).rejects.toMatchObject({ code: 'GIT_TOO_OLD', retryable: false });
    expect(remoteHead('task/8-old-git')).toBe(branch.head);
  });
});
