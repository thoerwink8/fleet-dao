// 推分支用真 git、本地裸仓当远端（不出网）。GitHub 接口（默认分支、换令牌）走假服务。
// 会话交出来的是包（git bundle）：这里在测试自己的树里打包，模拟会话用户那一步。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyPushFailure, execGit, type GitRunner } from '../src/git.ts';
import type { GitHubOptions } from '../src/github.ts';
import { validBranchName } from '../src/push.ts';
import { setup } from './helpers.ts';

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
let main: string;

/** 在 main 上起一棵加出来的工作树（引擎就是这么给会话建树的），在里面提交一次，再像会话用户那样打包交出来。 */
function worktree(
  branch: string,
  files: Record<string, string> = { [`${branch.replace(/\//g, '-')}.txt`]: branch },
) {
  const path = join(root, `wt-${branch.replace(/\//g, '-')}-${Math.random().toString(36).slice(2, 7)}`);
  git(main, 'fetch', '-q', 'origin');
  git(main, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main');
  const start = git(path, 'rev-parse', 'HEAD');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text);
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', `work on ${branch}`);
  return { path, start, head: git(path, 'rev-parse', 'HEAD'), bundle: bundleOf(path, start) };
}

/** 会话用户那一步：把起会话前的头之后的新提交打成包。 */
function bundleOf(tree: string, since: string): string {
  const file = join(root, `delivery-${Math.random().toString(36).slice(2, 9)}.bundle`);
  git(tree, 'bundle', 'create', '-q', file, 'HEAD', `^${since}`);
  return file;
}

function advanceRemoteMain(): string {
  const tmp = join(root, `adv-${Math.random().toString(36).slice(2, 7)}`);
  git(root, 'clone', '-q', remote, tmp);
  writeFileSync(join(tmp, `main-${Date.now()}-${Math.random()}.txt`), 'x');
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 'main moves');
  git(tmp, 'push', '-q', 'origin', 'HEAD:main');
  return git(tmp, 'rev-parse', 'HEAD');
}

function remoteHead(branch: string): string | null {
  const out = git(root, 'ls-remote', remote, `refs/heads/${branch}`);
  return out ? (out.split('\t')[0] ?? null) : null;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-gh-push-'));
  remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  main = join(root, 'main');
  git(root, 'clone', '-q', remote, main);
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'push', '-q', 'origin', 'HEAD:main');
}, 60_000);

function pushSetup(
  record?: { args: string[]; cwd: string; env: Record<string, string> }[],
  over: Partial<GitHubOptions> = {},
) {
  const runner: GitRunner = async (args, call) => {
    record?.push({ args, cwd: call.cwd, env: call.env });
    return execGit(args, call);
  };
  return setup({
    git: runner,
    gitUrl: () => remote,
    gitHost: 'https://github.com/',
    env: { ...process.env, GH_TOKEN: 'ghp_personalpersonalpersonal', GIT_ASKPASS: '/usr/bin/evil' },
    ...over,
  });
}

/** 包的两段：头（到空行为止）和后面的 pack。 */
function splitBundle(file: string): { header: Buffer; pack: Buffer } {
  const bytes = readFileSync(file);
  const at = bytes.indexOf('\n\nPACK');
  if (at < 0) throw new Error(`${file} 的格式认不出，造不了坏包`);
  return { header: bytes.subarray(0, at + 2), pack: bytes.subarray(at + 2) };
}

function writeBundle(name: string, bytes: Buffer): string {
  const file = join(root, `${name}-${Math.random().toString(36).slice(2, 9)}.bundle`);
  writeFileSync(file, bytes);
  return file;
}

/** 这台机器能不能建符号链接（Windows 没开开发者模式时不行）。 */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-gh-ln-'));
  try {
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    return true;
  } catch {
    return false;
  }
})();

// 每个用例要起十几个 git 进程：Linux 上一两百毫秒，Windows 开发机上要好几秒
describe('会话外推分支', { timeout: 60_000 }, () => {
  it('新分支推上去，远端的头就是它；令牌只在环境变量里、不在命令行参数里', async () => {
    const calls: { args: string[]; cwd: string; env: Record<string, string> }[] = [];
    const { gh, fake } = pushSetup(calls);
    const wt = worktree('task/1-new');
    const res = await gh.pushBranch({
      repo: { owner: 'acme', name: 'widgets' },
      bundlePath: wt.bundle,
      branch: 'task/1-new',
      head: wt.head,
    });
    expect(res).toMatchObject({ pushed: true, remoteBefore: null, head: wt.head, defaultBranch: 'main' });
    expect(remoteHead('task/1-new')).toBe(wt.head);

    // 用的是「干活的」机器人的令牌
    expect(fake.calls('POST', /access_tokens$/).map((r) => r.as)).toEqual(['app:agent']);
    const pushCall = calls.find((c) => c.args[0] === 'push');
    expect(pushCall).toBeDefined();
    for (const c of calls) {
      expect(c.args.join(' ')).not.toMatch(/ghs_|x-access-token|AUTHORIZATION/i);
      expect(c.env.GH_TOKEN).toBeUndefined();
      expect(c.env.GIT_ASKPASS).toBeUndefined();
      expect(c.env.GIT_TERMINAL_PROMPT).toBe('0');
    }
    const header = Object.entries(pushCall?.env ?? {}).find(([, v]) => v.startsWith('AUTHORIZATION: basic '));
    expect(header).toBeDefined();
    const keyName = header?.[0].replace('VALUE', 'KEY') ?? '';
    expect(pushCall?.env[keyName]).toBe('http.https://github.com/.extraHeader');
    // 引擎不碰会话的工作树：不在里面跑 git、不借它的对象库；交来的包也不直接给 git，
    // 先拷进引擎自己的裸仓目录再导入（导入时会话换包也换不到这份），导入那一步不带令牌
    expect(calls.filter((c) => c.cwd.startsWith(wt.path))).toEqual([]);
    expect(calls.filter((c) => c.args.some((a) => a.includes(wt.path) || a === wt.bundle))).toEqual([]);
    expect(calls.filter((c) => c.env.GIT_ALTERNATE_OBJECT_DIRECTORIES !== undefined)).toEqual([]);
    const unbundle = calls.filter((c) => c.args[0] === 'bundle');
    expect(unbundle).toHaveLength(1);
    expect(unbundle[0]?.args.slice(0, 2)).toEqual(['bundle', 'unbundle']);
    expect(unbundle[0]?.args[2]?.startsWith(join(unbundle[0]?.cwd ?? '', 'incoming-'))).toBe(true);
    expect(Object.values(unbundle[0]?.env ?? {}).filter((v) => v.startsWith('AUTHORIZATION'))).toEqual([]);
    // 拷贝用完就删
    expect(readdirSync(unbundle[0]?.cwd ?? '').filter((f) => f.startsWith('incoming-'))).toEqual([]);
  });

  it('拒绝推主线；分支名不合规就不推', async () => {
    const { gh } = pushSetup();
    const wt = worktree('task/2-main');
    const repo = { owner: 'acme', name: 'widgets' };
    await expect(
      gh.pushBranch({ repo, bundlePath: wt.bundle, branch: 'main', head: wt.head }),
    ).rejects.toMatchObject({
      code: 'BRANCH_FORBIDDEN',
    });
    await expect(
      gh.pushBranch({ repo, bundlePath: wt.bundle, branch: 'MAIN', head: wt.head }),
    ).rejects.toMatchObject({
      code: 'BRANCH_FORBIDDEN',
    });
    for (const bad of ['refs/heads/x', '-x', 'a..b', 'HEAD', 'a b', 'x.lock', '.hidden/x']) {
      expect(validBranchName(bad)).toBe(false);
    }
    expect(remoteHead('main')).not.toBe(wt.head);
  });

  it('不包含最新主线就不推：先同步主线', async () => {
    const { gh } = pushSetup();
    const wt = worktree('task/3-behind');
    advanceRemoteMain();
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath: wt.bundle,
        branch: 'task/3-behind',
        head: wt.head,
      }),
    ).rejects.toMatchObject({ code: 'BEHIND_MAINLINE', retryable: false });
    expect(remoteHead('task/3-behind')).toBeNull();
  });

  it('C7：没有自己的提交、或提交了但内容和主线一样，都不推', async () => {
    const { gh } = pushSetup();
    const repo = { owner: 'acme', name: 'widgets' };
    const wt = worktree('task/4-empty');
    git(wt.path, 'revert', '--no-edit', 'HEAD');
    const noDiff = git(wt.path, 'rev-parse', 'HEAD');
    await expect(
      gh.pushBranch({ repo, bundlePath: bundleOf(wt.path, wt.start), branch: 'task/4-empty', head: noDiff }),
    ).rejects.toMatchObject({
      code: 'EMPTY_DELIVERY',
    });
    const mainline = git(wt.path, 'rev-parse', 'origin/main');
    await expect(
      gh.pushBranch({ repo, bundlePath: wt.bundle, branch: 'task/4-empty', head: mainline }),
    ).rejects.toMatchObject({
      code: 'EMPTY_DELIVERY',
    });
    expect(remoteHead('task/4-empty')).toBeNull();
  });

  it('同一个头再推一次（重试）：什么都不做', async () => {
    const { gh } = pushSetup();
    const repo = { owner: 'acme', name: 'widgets' };
    const wt = worktree('task/5-again');
    await gh.pushBranch({ repo, bundlePath: wt.bundle, branch: 'task/5-again', head: wt.head });
    // 回执丢了再来一次：包可能已经被调用方收走了，也不影响
    const again = await gh.pushBranch({
      repo,
      bundlePath: join(root, 'already-collected.bundle'),
      branch: 'task/5-again',
      head: wt.head,
    });
    expect(again).toMatchObject({ pushed: false, remoteBefore: wt.head });
  });

  it('远端是我们的祖先：快进推', async () => {
    const { gh } = pushSetup();
    const repo = { owner: 'acme', name: 'widgets' };
    const wt = worktree('task/6-ff');
    await gh.pushBranch({ repo, bundlePath: wt.bundle, branch: 'task/6-ff', head: wt.head });
    // 返工：第二个会话从上次推上去的头起，只交这之后的新提交
    writeFileSync(join(wt.path, 'more.txt'), 'more');
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', 'more');
    const head2 = git(wt.path, 'rev-parse', 'HEAD');
    const res = await gh.pushBranch({
      repo,
      bundlePath: bundleOf(wt.path, wt.head),
      branch: 'task/6-ff',
      head: head2,
    });
    expect(res).toMatchObject({ pushed: true, remoteBefore: wt.head });
    expect(remoteHead('task/6-ff')).toBe(head2);
  });

  it('C6：远端在我们的提交之上被推进过——报出远端的新头，不覆盖', async () => {
    const { gh } = pushSetup();
    const repo = { owner: 'acme', name: 'widgets' };
    const wt = worktree('task/7-ahead');
    await gh.pushBranch({ repo, bundlePath: wt.bundle, branch: 'task/7-ahead', head: wt.head });
    const other = join(root, 'other-7');
    git(root, 'clone', '-q', '-b', 'task/7-ahead', remote, other);
    writeFileSync(join(other, 'by-someone.txt'), 'x');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'someone else');
    git(other, 'push', '-q', 'origin', 'HEAD:task/7-ahead');
    const theirs = git(other, 'rev-parse', 'HEAD');
    await expect(
      gh.pushBranch({ repo, bundlePath: wt.bundle, branch: 'task/7-ahead', head: wt.head }),
    ).rejects.toMatchObject({
      code: 'REMOTE_AHEAD',
      details: { remoteHead: theirs },
    });
    expect(remoteHead('task/7-ahead')).toBe(theirs);
  });

  it('分叉了：不强推，远端原样', async () => {
    const { gh } = pushSetup();
    const repo = { owner: 'acme', name: 'widgets' };
    const wt = worktree('task/8-fork');
    await gh.pushBranch({ repo, bundlePath: wt.bundle, branch: 'task/8-fork', head: wt.head });
    const other = join(root, 'other-8');
    git(root, 'clone', '-q', '-b', 'task/8-fork', remote, other);
    writeFileSync(join(other, 'theirs.txt'), 'x');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q', 'origin', 'HEAD:task/8-fork');
    const theirs = git(other, 'rev-parse', 'HEAD');
    writeFileSync(join(wt.path, 'ours.txt'), 'y');
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', 'ours');
    const ours = git(wt.path, 'rev-parse', 'HEAD');
    await expect(
      gh.pushBranch({ repo, bundlePath: bundleOf(wt.path, wt.head), branch: 'task/8-fork', head: ours }),
    ).rejects.toMatchObject({
      code: 'DIVERGED',
    });
    expect(remoteHead('task/8-fork')).toBe(theirs);
  });

  it('包里没有这个提交：报 HEAD_NOT_FOUND', async () => {
    const { gh } = pushSetup();
    const wt = worktree('task/9-missing');
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath: wt.bundle,
        branch: 'task/9-missing',
        head: 'f'.repeat(40),
      }),
    ).rejects.toMatchObject({ code: 'HEAD_NOT_FOUND' });
    expect(remoteHead('task/9-missing')).toBeNull();
  });

  it('包读不到、不是包、缺前置提交：各报各的错，一个都不推', async () => {
    const { gh } = pushSetup();
    const repo = { owner: 'acme', name: 'widgets' };
    const wt = worktree('task/11-bad-bundle');

    await expect(
      gh.pushBranch({
        repo,
        bundlePath: join(root, 'no-such.bundle'),
        branch: 'task/11-bad-bundle',
        head: wt.head,
      }),
    ).rejects.toMatchObject({ code: 'BUNDLE_UNREADABLE', retryable: false });
    await expect(
      gh.pushBranch({ repo, bundlePath: root, branch: 'task/11-bad-bundle', head: wt.head }),
    ).rejects.toMatchObject({ code: 'BUNDLE_INVALID', retryable: false });

    const junk = join(root, 'junk.bundle');
    writeFileSync(junk, 'not a bundle\n');
    await expect(
      gh.pushBranch({ repo, bundlePath: junk, branch: 'task/11-bad-bundle', head: wt.head }),
    ).rejects.toMatchObject({ code: 'BUNDLE_INVALID', retryable: false });

    // 上一个会话的提交从没推上去，这次只交了它之后的：引擎这边补不齐
    writeFileSync(join(wt.path, 'later.txt'), 'later');
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', 'later');
    const later = git(wt.path, 'rev-parse', 'HEAD');
    await expect(
      gh.pushBranch({
        repo,
        bundlePath: bundleOf(wt.path, wt.head),
        branch: 'task/11-bad-bundle',
        head: later,
      }),
    ).rejects.toMatchObject({ code: 'BUNDLE_INCOMPLETE', retryable: false });

    expect(remoteHead('task/11-bad-bundle')).toBeNull();
  });

  it('C3：推送因 workflows 权限被拒，一次判「要人」，不当可重试', async () => {
    const stderr =
      'remote: error: GH013 ...\n ! [remote rejected] abc -> task/x (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\nerror: failed to push some refs';
    expect(classifyPushFailure(stderr)).toBe('workflow_permission');
    const runner: GitRunner = async (args, call) =>
      args[0] === 'push' ? { code: 1, stdout: '', stderr } : execGit(args, call);
    const { gh } = setup({ git: runner, gitUrl: () => remote, env: {} });
    const wt = worktree('task/10-wf');
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath: wt.bundle,
        branch: 'task/10-wf',
        head: wt.head,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_PERMISSION', retryable: false });
  });

  // 坏包拿去重试只会再坏一次：一律不可重试，原因要分对（不能归成网络错）
  it('只有头、没有 pack 的包：BUNDLE_INVALID，不可重试', async () => {
    const { gh } = pushSetup();
    const wt = worktree('task/12-header-only');
    const bundlePath = writeBundle('header-only', splitBundle(wt.bundle).header);
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath,
        branch: 'task/12-header-only',
        head: wt.head,
      }),
    ).rejects.toMatchObject({ code: 'BUNDLE_INVALID', retryable: false });
    expect(remoteHead('task/12-header-only')).toBeNull();
  });

  it('截断了的包：BUNDLE_INVALID，不可重试', async () => {
    const { gh } = pushSetup();
    const wt = worktree('task/13-truncated');
    const { header, pack } = splitBundle(wt.bundle);
    const bundlePath = writeBundle(
      'truncated',
      Buffer.concat([header, pack.subarray(0, Math.floor(pack.length / 2))]),
    );
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath,
        branch: 'task/13-truncated',
        head: wt.head,
      }),
    ).rejects.toMatchObject({ code: 'BUNDLE_INVALID', retryable: false });
    expect(remoteHead('task/13-truncated')).toBeNull();
  });

  it('改坏一个字节的包：BUNDLE_INVALID，不可重试；导入失败也不留拷贝', async () => {
    const calls: { args: string[]; cwd: string; env: Record<string, string> }[] = [];
    const { gh } = pushSetup(calls);
    const wt = worktree('task/14-corrupt');
    const { header, pack } = splitBundle(wt.bundle);
    const broken = Buffer.from(pack);
    const at = Math.floor(broken.length / 2);
    broken[at] = (broken[at] ?? 0) ^ 0xff;
    const bundlePath = writeBundle('corrupt', Buffer.concat([header, broken]));
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath,
        branch: 'task/14-corrupt',
        head: wt.head,
      }),
    ).rejects.toMatchObject({ code: 'BUNDLE_INVALID', retryable: false });
    expect(remoteHead('task/14-corrupt')).toBeNull();
    const mirror = calls.find((c) => c.args[0] === 'bundle')?.cwd ?? '';
    expect(mirror).not.toBe('');
    expect(readdirSync(mirror).filter((f) => f.startsWith('incoming-'))).toEqual([]);
  });

  it('缺对象的包（只带提交、不带它的树）：导入后就核出来，BUNDLE_INCOMPLETE，不可重试', async () => {
    const { gh } = pushSetup();
    const wt = worktree('task/15-missing-objects');
    // 头照抄真包，pack 里只放提交对象本身
    const onlyCommit = execFileSync('git', ['pack-objects', '--stdout', '-q'], {
      cwd: wt.path,
      input: `${wt.head}\n`,
    });
    const bundlePath = writeBundle(
      'missing-objects',
      Buffer.concat([splitBundle(wt.bundle).header, onlyCommit]),
    );
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath,
        branch: 'task/15-missing-objects',
        head: wt.head,
      }),
    ).rejects.toMatchObject({ code: 'BUNDLE_INCOMPLETE', retryable: false });
    expect(remoteHead('task/15-missing-objects')).toBeNull();
  });

  it('包超过大小上限：BUNDLE_TOO_LARGE，不读进来', async () => {
    const calls: { args: string[]; cwd: string; env: Record<string, string> }[] = [];
    const { gh } = pushSetup(calls, { maxBundleBytes: 64 });
    const wt = worktree('task/16-too-large');
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath: wt.bundle,
        branch: 'task/16-too-large',
        head: wt.head,
      }),
    ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE', retryable: false });
    expect(calls.filter((c) => c.args[0] === 'bundle')).toEqual([]);
    expect(remoteHead('task/16-too-large')).toBeNull();
  });

  it.skipIf(!canSymlink)('包是符号链接：不跟过去读', async () => {
    const { gh } = pushSetup();
    const wt = worktree('task/17-symlink');
    const link = join(root, `link-${Math.random().toString(36).slice(2, 9)}.bundle`);
    symlinkSync(wt.bundle, link);
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath: link,
        branch: 'task/17-symlink',
        head: wt.head,
      }),
    ).rejects.toMatchObject({
      code: 'BUNDLE_INVALID',
      retryable: false,
      message: expect.stringContaining('是符号链接'),
    });
    expect(remoteHead('task/17-symlink')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('包是命名管道：不卡在打开上，BUNDLE_INVALID', async () => {
    const { gh } = pushSetup();
    const wt = worktree('task/18-fifo');
    const fifo = join(root, `fifo-${Math.random().toString(36).slice(2, 9)}.bundle`);
    execFileSync('mkfifo', [fifo]);
    await expect(
      gh.pushBranch({
        repo: { owner: 'acme', name: 'widgets' },
        bundlePath: fifo,
        branch: 'task/18-fifo',
        head: wt.head,
      }),
    ).rejects.toMatchObject({
      code: 'BUNDLE_INVALID',
      retryable: false,
      message: expect.stringContaining('不是普通文件'),
    });
    expect(remoteHead('task/18-fifo')).toBeNull();
  });

  it('推送失败的分类：规则集、凭据、网络', () => {
    expect(classifyPushFailure('remote: error: GH013: Repository rule violations found')).toBe(
      'rule_rejected',
    );
    expect(classifyPushFailure("fatal: Authentication failed for 'https://github.com/x/y.git/'")).toBe(
      'auth',
    );
    expect(classifyPushFailure('error: RPC failed; HTTP 502 curl 22')).toBe('transient');
    expect(classifyPushFailure(' ! [rejected]        x -> x (non-fast-forward)')).toBe('non_fast_forward');
  });
});
