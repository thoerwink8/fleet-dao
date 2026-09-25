// 从镜像打包：真 git、本地裸仓当远端（不出网），和 push.test.ts / sync.test.ts 一样。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
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
let mainHead: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-gh-bundle-'));
  remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  mainHead = git(seed, 'rev-parse', 'HEAD');
}, 60_000);

function bundleSetup() {
  return setup({ git: execGit, gitUrl: () => remote, gitHost: 'https://github.com/', env: {} });
}

function outFile(name: string): string {
  return join(root, `${name}-${Math.random().toString(36).slice(2, 9)}.bundle`);
}

describe('从镜像打包', { timeout: 60_000 }, () => {
  it('fetchMainline 抓到远端 main 的头；bundleCommits 打出的包能被另一个空仓 fetch 出同一个头', async () => {
    const { gh } = bundleSetup();
    const fetched = await gh.fetchMainline({ repo });
    expect(fetched).toEqual({ head: mainHead, defaultBranch: 'main' });

    const outPath = outFile('main');
    const res = await gh.bundleCommits({ repo, tips: [fetched.head], outPath });
    expect(res.path).toBe(outPath);
    expect(res.bytes).toBe(statSync(outPath).size);
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.refs).toEqual([{ tip: fetched.head, ref: 'refs/fleet/export/0' }]);

    const empty = join(root, `empty-${Math.random().toString(36).slice(2, 7)}`);
    git(root, 'init', '-q', '-b', 'unrelated', empty);
    git(empty, 'fetch', '-q', outPath, `${res.refs[0]?.ref}:refs/heads/imported`);
    expect(git(empty, 'rev-parse', 'refs/heads/imported')).toBe(fetched.head);
  });

  it('打包后镜像里不留导出引用（用完即删）', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-gh-state-'));
    const { gh } = setup({
      git: execGit,
      gitUrl: () => remote,
      gitHost: 'https://github.com/',
      env: {},
      stateDir,
    });
    const fetched = await gh.fetchMainline({ repo });
    await gh.bundleCommits({ repo, tips: [fetched.head], outPath: outFile('cleanup') });
    const mirror = join(stateDir, 'mirrors', repo.owner.toLowerCase(), `${repo.name.toLowerCase()}.git`);
    expect(git(mirror, 'for-each-ref', 'refs/fleet/export')).toBe('');
  });

  it('两个 tip、排除其中一个的祖先：包依然能各自 fetch 出正确的头，且忽略镜像里没有的 exclude', async () => {
    const { gh } = bundleSetup();
    // tips 必须已经在镜像里：走 pushBranch（真实流程里镜像就是这么收到分支提交的），不直接拿 plain git 推。
    const wt = join(root, `wt-two-${Math.random().toString(36).slice(2, 7)}`);
    git(root, 'clone', '-q', '-b', 'main', remote, wt);
    git(wt, 'checkout', '-q', '-b', 'task/two-tips');
    writeFileSync(join(wt, 'x.txt'), '1\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'c1');
    const tip1 = git(wt, 'rev-parse', 'HEAD');
    const bundle1 = join(root, `bundle1-${Math.random().toString(36).slice(2, 7)}.bundle`);
    git(wt, 'bundle', 'create', '-q', bundle1, 'HEAD', `^${mainHead}`);
    await gh.pushBranch({ repo, bundlePath: bundle1, branch: 'task/two-tips', head: tip1 });

    writeFileSync(join(wt, 'x.txt'), '2\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'c2');
    const tip2 = git(wt, 'rev-parse', 'HEAD');
    const bundle2 = join(root, `bundle2-${Math.random().toString(36).slice(2, 7)}.bundle`);
    git(wt, 'bundle', 'create', '-q', bundle2, 'HEAD', `^${tip1}`);
    await gh.pushBranch({ repo, bundlePath: bundle2, branch: 'task/two-tips', head: tip2 });

    const outPath = outFile('two-tips');
    const missing = 'f'.repeat(40);
    const res = await gh.bundleCommits({
      repo,
      tips: [tip1, tip2],
      exclude: [mainHead, missing],
      outPath,
    });
    expect(res.refs).toEqual([
      { tip: tip1, ref: 'refs/fleet/export/0' },
      { tip: tip2, ref: 'refs/fleet/export/1' },
    ]);

    // 这个包排除了 mainHead 之后的祖先，是「增量包」：接的一方要已经有 mainHead（真实场景里是会话已有的本地克隆），
    // 不能指望空仓单靠这一个包补全，这里克隆远端来模拟「已有旧头的本地克隆」。
    const empty = join(root, `empty2-${Math.random().toString(36).slice(2, 7)}`);
    git(root, 'clone', '-q', remote, empty);
    git(empty, 'fetch', '-q', outPath, `${res.refs[0]?.ref}:refs/heads/one`);
    git(empty, 'fetch', '-q', outPath, `${res.refs[1]?.ref}:refs/heads/two`);
    expect(git(empty, 'rev-parse', 'refs/heads/one')).toBe(tip1);
    expect(git(empty, 'rev-parse', 'refs/heads/two')).toBe(tip2);
  });

  it('tip 不在镜像里：报 HEAD_NOT_FOUND，不写文件', async () => {
    const { gh } = bundleSetup();
    const missing = 'a'.repeat(40);
    await expect(
      gh.bundleCommits({ repo, tips: [missing], outPath: outFile('missing') }),
    ).rejects.toMatchObject({ code: 'HEAD_NOT_FOUND' });
  });

  it('以 - 开头的 tip / exclude 一律拒收（防参数注入）', async () => {
    const { gh } = bundleSetup();
    await expect(gh.bundleCommits({ repo, tips: ['-x'], outPath: outFile('bad-tip') })).rejects.toMatchObject(
      { code: 'BAD_INPUT' },
    );
    await expect(
      gh.bundleCommits({
        repo,
        tips: [mainHead],
        exclude: ['--upload-pack=evil'],
        outPath: outFile('bad-exclude'),
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('不是 40 位十六进制、也不是 refs/fleet/ 引用的 tip：同样报 BAD_INPUT', async () => {
    const { gh } = bundleSetup();
    await expect(
      gh.bundleCommits({ repo, tips: ['not-a-sha'], outPath: outFile('junk-tip') }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('fetchMainline 抓取主线失败（网络类）：报 GIT_FAILED，可重试，不吞', async () => {
    const runner: GitRunner = async (args, call) =>
      args[0] === 'fetch'
        ? { code: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.test' }
        : execGit(args, call);
    const { gh } = setup({ git: runner, gitUrl: () => remote, gitHost: 'https://github.com/', env: {} });
    await expect(gh.fetchMainline({ repo })).rejects.toMatchObject({ code: 'GIT_FAILED', retryable: true });
  });

  it('fetchMainline 抓到远端后解析不出主线提交号：报 GIT_FAILED，可重试', async () => {
    const runner: GitRunner = async (args, call) =>
      args[0] === 'rev-parse' ? { code: 128, stdout: '', stderr: '' } : execGit(args, call);
    const { gh } = setup({ git: runner, gitUrl: () => remote, gitHost: 'https://github.com/', env: {} });
    await expect(gh.fetchMainline({ repo })).rejects.toMatchObject({ code: 'GIT_FAILED', retryable: true });
  });

  it('打包输出文件所在目录没建：报 BUNDLE_OUT_UNWRITABLE，不可重试', async () => {
    const { gh } = bundleSetup();
    const fetched = await gh.fetchMainline({ repo });
    const outPath = join(root, `no-such-dir-${Math.random().toString(36).slice(2, 7)}`, 'x.bundle');
    await expect(gh.bundleCommits({ repo, tips: [fetched.head], outPath })).rejects.toMatchObject({
      code: 'BUNDLE_OUT_UNWRITABLE',
      retryable: false,
    });
  });

  it('git bundle create 失败：报 GIT_FAILED，可重试，且失败后也不留导出引用', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-gh-state-'));
    const runner: GitRunner = async (args, call) =>
      args[0] === 'bundle' && args[1] === 'create'
        ? { code: 128, stdout: '', stderr: 'fatal: unable to write bundle: No space left on device' }
        : execGit(args, call);
    const { gh } = setup({
      git: runner,
      gitUrl: () => remote,
      gitHost: 'https://github.com/',
      env: {},
      stateDir,
    });
    const fetched = await gh.fetchMainline({ repo });
    await expect(
      gh.bundleCommits({ repo, tips: [fetched.head], outPath: outFile('bundle-create-fail') }),
    ).rejects.toMatchObject({ code: 'GIT_FAILED', retryable: true });
    const mirror = join(stateDir, 'mirrors', repo.owner.toLowerCase(), `${repo.name.toLowerCase()}.git`);
    expect(git(mirror, 'for-each-ref', 'refs/fleet/export')).toBe('');
  });
});
