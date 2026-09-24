// 交付判据用真 git 测：一个裸仓当 origin，一份工作树；要模拟别人往主线推时再克隆一份。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDelivery } from '../src/delivery.ts';
import { git, isolatedGitEnv, tempDir } from './helpers.ts';

function setup() {
  const env = isolatedGitEnv();
  const root = tempDir();
  const origin = join(root, 'origin.git');
  const tree = join(root, 'tree');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin], env);
  git(root, ['init', '-q', '-b', 'main', tree], env);
  git(tree, ['remote', 'add', 'origin', origin], env);
  writeFileSync(join(tree, 'README.md'), 'hello\n');
  git(tree, ['add', '-A'], env);
  git(tree, ['commit', '-q', '-m', 'init'], env);
  git(tree, ['push', '-q', 'origin', 'HEAD:main'], env);
  const head = () => git(tree, ['rev-parse', 'HEAD'], env).trim();
  /** 起会话之前的 HEAD。 */
  const base = head();
  const commit = (dir: string, file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    git(dir, ['add', '-A'], env);
    git(dir, ['commit', '-q', '-m', `change ${file}`], env);
  };
  /** 另一个人的克隆，往主线推一个提交。 */
  const someoneElsePushes = () => {
    const other = join(root, 'other');
    git(root, ['clone', '-q', origin, other], env);
    commit(other, 'b.txt', 'b\n');
    git(other, ['push', '-q', 'origin', 'HEAD:main'], env);
  };
  const check = (since = base, fetch = true) =>
    checkDelivery({ cwd: tree, remote: 'origin', branch: 'main', since, fetch, env });
  return { env, tree, head, commit, someoneElsePushes, check };
}

// 每个用例要起十来个 git 进程，Windows 开发机并行跑时会超过默认的 5 秒
describe('checkDelivery', { timeout: 30_000 }, () => {
  it('这一轮有自己的提交、内容有差异、没有漏提交的改动：交付了', async () => {
    const { tree, commit, check } = setup();
    commit(tree, 'a.txt', 'a\n');
    expect(await check()).toMatchObject({
      state: 'delivered',
      ownCommits: 1,
      newCommits: 1,
      hasDiff: true,
      uncommitted: 0,
    });
  });

  it('什么都没提交：没交付', async () => {
    const { check } = setup();
    const result = await check();
    expect(result).toMatchObject({ state: 'not_delivered', ownCommits: 0, newCommits: 0 });
    expect(result.detail).toContain('没有自己的提交');
  });

  it('续会话那一轮什么都没做：不能靠上一轮的提交算交付', async () => {
    const { tree, head, commit, check } = setup();
    commit(tree, 'a.txt', 'a\n');
    const afterFirstRound = head();
    expect((await check()).state).toBe('delivered');
    // 第二轮从上一轮结束时的 HEAD 起，一个提交都没加
    const second = await check(afterFirstRound);
    expect(second).toMatchObject({ state: 'not_delivered', ownCommits: 1, newCommits: 0 });
    expect(second.detail).toContain('这一轮会话没有新提交');
  });

  it('已跟踪的文件还有没提交的改动：没交付（引擎只推提交，这部分会丢）', async () => {
    const { tree, commit, check } = setup();
    commit(tree, 'a.txt', 'a\n');
    writeFileSync(join(tree, 'README.md'), 'hello again\n');
    const result = await check();
    expect(result).toMatchObject({ state: 'not_delivered', newCommits: 1, uncommitted: 1 });
    expect(result.detail).toContain('没提交');
  });

  it('没跟踪的文件（构建产物之类）不挡交付', async () => {
    const { tree, commit, check } = setup();
    commit(tree, 'a.txt', 'a\n');
    writeFileSync(join(tree, 'build.log'), 'x\n');
    expect(await check()).toMatchObject({ state: 'delivered', uncommitted: 0 });
  });

  it('树被快进到别人推的新主线、自己一行没写：没交付（windsurf-dao#1572 那次假完成）', async () => {
    const { env, tree, someoneElsePushes, check } = setup();
    someoneElsePushes();
    git(tree, ['pull', '-q', '--ff-only', 'origin', 'main'], env);
    // HEAD 变了，since..HEAD 也有提交，但相对此刻的 origin/main 没有自己的提交
    expect(await check()).toMatchObject({ state: 'not_delivered', ownCommits: 0, newCommits: 1 });
  });

  it('不先抓最新主线就比，同一棵树会被误判成交付——所以默认要抓', async () => {
    const { env, tree, someoneElsePushes, check } = setup();
    someoneElsePushes();
    // 模拟「树里拿到了新主线，但 origin/main 还停在旧位置」
    git(tree, ['fetch', '-q', 'origin', 'main:refs/heads/tmp'], env);
    git(tree, ['merge', '-q', '--ff-only', 'tmp'], env);
    git(tree, ['update-ref', 'refs/remotes/origin/main', 'HEAD~1'], env);
    expect((await check(undefined, false)).state).toBe('delivered');
    expect((await check(undefined, true)).state).toBe('not_delivered');
  });

  it('提交了又撤回，净差异为零：没交付', async () => {
    const { env, tree, commit, check } = setup();
    commit(tree, 'a.txt', 'a\n');
    git(tree, ['revert', '--no-edit', 'HEAD'], env);
    expect(await check()).toMatchObject({ state: 'not_delivered', ownCommits: 2, hasDiff: false });
  });

  it('抓不到目标分支、找不到起点提交：没查成，不当成没交付', async () => {
    const { tree, env, check } = setup();
    const since = git(tree, ['rev-parse', 'HEAD'], env).trim();
    const noBranch = await checkDelivery({
      cwd: tree,
      remote: 'origin',
      branch: 'no-such-branch',
      since,
      env,
    });
    expect(noBranch.state).toBe('unknown');
    const offline = await checkDelivery({ cwd: tree, remote: 'nowhere', branch: 'main', since, env });
    expect(offline.state).toBe('unknown');
    expect((await check('0123456789abcdef0123456789abcdef01234567')).state).toBe('unknown');
  });
});
