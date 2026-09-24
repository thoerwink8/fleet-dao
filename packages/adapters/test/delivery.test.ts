// 交付判据用真 git 测：一个裸仓当 origin，一份克隆当工作树，另一份克隆模拟别人往主线推。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDelivery } from '../src/delivery.ts';
import { git, isolatedGitEnv, tempDir } from './helpers.ts';

function setup() {
  const env = isolatedGitEnv();
  const root = tempDir();
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const tree = join(root, 'tree');
  const other = join(root, 'other');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin], env);
  git(root, ['init', '-q', '-b', 'main', seed], env);
  git(seed, ['remote', 'add', 'origin', origin], env);
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  git(seed, ['add', '-A'], env);
  git(seed, ['commit', '-q', '-m', 'init'], env);
  git(seed, ['push', '-q', 'origin', 'HEAD:main'], env);
  git(root, ['clone', '-q', origin, tree], env);
  git(root, ['clone', '-q', origin, other], env);
  const commit = (dir: string, file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    git(dir, ['add', '-A'], env);
    git(dir, ['commit', '-q', '-m', `change ${file}`], env);
  };
  const check = (fetch = true) => checkDelivery({ cwd: tree, remote: 'origin', branch: 'main', fetch, env });
  return { env, tree, other, commit, check };
}

describe('checkDelivery', () => {
  it('有自己的提交且内容有差异：交付了', async () => {
    const { tree, commit, check } = setup();
    commit(tree, 'a.txt', 'a\n');
    expect(await check()).toMatchObject({ state: 'delivered', ownCommits: 1, hasDiff: true, uncommitted: 0 });
  });

  it('什么都没提交：没交付，并数出没提交的改动', async () => {
    const { tree, check } = setup();
    writeFileSync(join(tree, 'draft.txt'), 'wip\n');
    const result = await check();
    expect(result).toMatchObject({ state: 'not_delivered', ownCommits: 0, hasDiff: false, uncommitted: 1 });
    expect(result.detail).toContain('没提交');
  });

  it('树被快进到别人推的新主线、自己一行没写：没交付（windsurf-dao#1572 那次假完成）', async () => {
    const { env, tree, other, commit, check } = setup();
    commit(other, 'b.txt', 'b\n');
    git(other, ['push', '-q', 'origin', 'HEAD:main'], env);
    git(tree, ['pull', '-q', '--ff-only', 'origin', 'main'], env);
    // HEAD 变了，但相对此刻的 origin/main 没有自己的提交
    expect(await check()).toMatchObject({ state: 'not_delivered', ownCommits: 0 });
  });

  it('不先抓最新主线就比，同一棵树会被误判成交付——所以默认要抓', async () => {
    const { env, tree, other, commit, check } = setup();
    commit(other, 'b.txt', 'b\n');
    git(other, ['push', '-q', 'origin', 'HEAD:main'], env);
    // 模拟「树里拿到了新主线，但 origin/main 还停在旧位置」
    git(tree, ['fetch', '-q', 'origin', 'main:refs/heads/tmp'], env);
    git(tree, ['merge', '-q', '--ff-only', 'tmp'], env);
    git(tree, ['update-ref', 'refs/remotes/origin/main', 'HEAD~1'], env);
    expect((await check(false)).state).toBe('delivered');
    expect((await check(true)).state).toBe('not_delivered');
  });

  it('提交了又撤回，净差异为零：没交付', async () => {
    const { env, tree, commit, check } = setup();
    commit(tree, 'a.txt', 'a\n');
    git(tree, ['revert', '--no-edit', 'HEAD'], env);
    expect(await check()).toMatchObject({ state: 'not_delivered', ownCommits: 2, hasDiff: false });
  });

  it('抓不到目标分支：没查成，不当成没交付', async () => {
    const { tree, env } = setup();
    const result = await checkDelivery({ cwd: tree, remote: 'origin', branch: 'no-such-branch', env });
    expect(result.state).toBe('unknown');
    const offline = await checkDelivery({ cwd: tree, remote: 'nowhere', branch: 'main', env });
    expect(offline.state).toBe('unknown');
  });
});
