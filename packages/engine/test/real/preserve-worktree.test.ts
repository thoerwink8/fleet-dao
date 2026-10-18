// 真 Git 验收：删原树后从独立成果包恢复，包括 detached HEAD、分叉标签、二进制内容与基线关系。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localExec, type UserExec } from '../../src/real/exec.ts';
import { preserveWorktree } from '../../src/real/preserve-worktree.ts';
import type { UserTree } from '../../src/real/user-git.ts';
import { git } from './fixtures.ts';

let root: string;
let t: UserTree;
let base: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-preserve-'));
  const dir = join(root, 'work');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'base.txt'), 'baseline\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'baseline');
  base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/fleet/incoming', base);
  t = {
    exec: localExec(),
    user: 'fleet-agent-carpool',
    dir,
    scopePrefix: 'preserve-test',
    git: 'git',
    sh: 'sh',
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function commit(file = 'work.bin'): string {
  writeFileSync(join(t.dir, file), Buffer.from([0, 255, 1, 128, 10]));
  git(t.dir, 'add', '--', file);
  git(t.dir, 'commit', '-q', '-m', file);
  return git(t.dir, 'rev-parse', 'HEAD');
}

describe('删除前真实成果保全', { timeout: 120_000 }, () => {
  it('干净未发布HEAD、完整基线、另一个标签分叉均可脱离原树恢复', async () => {
    const other = commit('other.bin');
    git(t.dir, 'tag', 'saved-other', other);
    git(t.dir, 'checkout', '-q', '--detach', base);
    const head = commit();
    const dir = await preserveWorktree(t, join(root, 'archive'), { taskId: '3056' });
    expect(dir).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(dir as string, 'manifest.json'), 'utf8'));
    expect(manifest.identity.split('\n')[0]).toBe(head);
    rmSync(t.dir, { recursive: true });
    const restored = join(root, 'restored');
    git(root, 'clone', '-q', join(dir as string, 'recovery.bundle'), restored);
    git(restored, 'checkout', '-q', '--detach', head);
    expect(git(restored, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(restored, 'rev-parse', 'HEAD^')).toBe(base);
    expect(readFileSync(join(restored, 'work.bin'))).toEqual(Buffer.from([0, 255, 1, 128, 10]));
    expect(git(restored, 'rev-parse', 'saved-other')).toBe(other);
    if (process.platform !== 'win32') {
      expect(statSync(dir as string).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir as string, 'recovery.bundle')).mode & 0o777).toBe(0o600);
    }
  });

  it('重试独立存档不覆盖旧包；已发布且无独有成果无需存档', async () => {
    expect(await preserveWorktree(t, join(root, 'archive'))).toBeUndefined();
    commit();
    const first = await preserveWorktree(t, join(root, 'archive'));
    const bytes = readFileSync(join(first as string, 'recovery.bundle'));
    const second = await preserveWorktree(t, join(root, 'archive'));
    expect(second).not.toBe(first);
    expect(readFileSync(join(first as string, 'recovery.bundle'))).toEqual(bytes);
  });

  it.each(['tracked-binary', 'staged', 'untracked-binary', 'stash'] as const)(
    '%s 保留原树全部成果，不以patch代替原物',
    async (kind) => {
      if (kind === 'untracked-binary') writeFileSync(join(t.dir, 'new.bin'), Buffer.from([0, 255]));
      else {
        writeFileSync(join(t.dir, 'base.txt'), Buffer.from([0, 255, 8]));
        if (kind === 'staged') git(t.dir, 'add', '.');
        if (kind === 'stash') git(t.dir, 'stash', 'push', '-q');
      }
      await expect(preserveWorktree(t, join(root, 'archive'))).rejects.toMatchObject({
        code: 'WORKTREE_PRESERVED',
      });
      expect(existsSync(t.dir)).toBe(true);
      if (kind === 'stash') expect(git(t.dir, 'stash', 'list')).not.toBe('');
      else
        expect(readFileSync(join(t.dir, kind === 'untracked-binary' ? 'new.bin' : 'base.txt'))).toContain(
          255,
        );
    },
  );

  it('读失败、保存失败、空仓恢复失败均不放行，重试不删除失败存档', async () => {
    commit();
    const exec = localExec();
    const bad: UserExec = async (c) =>
      c.argv.includes('status')
        ? { code: 128, stdout: Buffer.alloc(0), stderr: 'cannot read', timedOut: false, aborted: false }
        : exec(c);
    await expect(preserveWorktree({ ...t, exec: bad }, join(root, 'archive'))).rejects.toThrow('cannot read');
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'file');
    await expect(preserveWorktree(t, blocked)).rejects.toThrow();
    const failedVerify: UserExec = async (c) =>
      c.argv.some((a) => a.includes('bundle verify'))
        ? {
            code: 128,
            stdout: Buffer.alloc(0),
            stderr: 'recovery read failed',
            timedOut: false,
            aborted: false,
          }
        : exec(c);
    await expect(preserveWorktree({ ...t, exec: failedVerify }, join(root, 'archive'))).rejects.toMatchObject(
      { code: 'ARCHIVE_FAILED' },
    );
    expect(existsSync(t.dir)).toBe(true);
    const failedDir = readdirSync(join(root, 'archive'))[0] as string;
    expect(existsSync(join(root, 'archive', failedDir, 'manifest.json'))).toBe(false);
    expect(await preserveWorktree(t, join(root, 'archive'))).toBeDefined();
    expect(existsSync(join(root, 'archive', failedDir, 'recovery.bundle'))).toBe(true);
  });

  it('打包之后出现新的未跟踪成果，核验完成也不能放行', async () => {
    commit();
    const exec = localExec();
    const racing: UserExec = async (c) => {
      const r = await exec(c);
      if (c.argv.some((a) => a.includes('bundle verify')))
        writeFileSync(join(t.dir, 'late.txt'), 'late result');
      return r;
    };
    await expect(preserveWorktree({ ...t, exec: racing }, join(root, 'archive'))).rejects.toMatchObject({
      code: 'WORKTREE_PRESERVED',
    });
    expect(readFileSync(join(t.dir, 'late.txt'), 'utf8')).toBe('late result');
  });
});
