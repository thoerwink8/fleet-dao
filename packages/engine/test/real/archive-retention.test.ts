// 归档回收：已推到远端、又没有未提交内容的归档，过保留期或超上限就回收；判不清的一律留着。
// 这里只用假口子（不连 GitHub、不起真 Git），钉住判据本身。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARCHIVE_RETENTION_LIMITS,
  type ArchiveRetentionDeps,
  judgeArchive,
  readArchiveFacts,
  recycleArchives,
} from '../../src/real/archive-retention.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-archive-retention-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 造一个归档目录，返回它的路径。 */
function makeArchive(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  return dir;
}

/** 回执：receipt/state/manifest 任一份，带 head。 */
function receipt(head: string, kind: 'receipt' | 'state' | 'manifest' = 'receipt'): Record<string, string> {
  return { [`${kind}.json`]: JSON.stringify({ head, identity: `${head}\n` }) };
}

/** state.json 带文件清单；可以带 stash / merge（这两样 bundle 带不走）。 */
function stateWith(
  head: string,
  files: Array<{ path: string; sha256: string }>,
  extra: { stash?: number; merge?: number } = {},
): Record<string, string> {
  return {
    'state.json': JSON.stringify({
      head,
      files: files.map((f) => ({ kind: 'file', ...f })),
      stash: Array.from({ length: extra.stash ?? 0 }, () => ({ ref: 'stash', sha256: 'x' })),
      merge: Array.from({ length: extra.merge ?? 0 }, () => ({ sha256: 'y' })),
    }),
    'recovery.bundle': 'bundle',
  };
}

function deps(over: Partial<ArchiveRetentionDeps> = {}): ArchiveRetentionDeps {
  return {
    archiveDir: root,
    isHeadPushed: async () => true,
    readHeadTree: async (_head, _bundle) => new Map([['a.ts', 'aaa']]),
    // 测试环境是 Windows 临时目录，走不了生产那条受限路径（名字规则不许冒号）。这里用普通删。
    removeDir: async (dir) => {
      rmSync(dir, { recursive: true, force: true });
      return true;
    },
    now: () => 1_700_000_000_000,
    ...over,
  };
}

describe('归档回收判据', () => {
  it('干净归档（只有 git 历史）HEAD 在远端就回收', async () => {
    const dir = makeArchive('worktree-clean', { ...receipt('deadbeef'), 'recovery.bundle': 'x' });
    const facts = await readArchiveFacts(dir);
    expect(facts.shape).toBe('receipt');
    expect(await judgeArchive(facts, deps())).toEqual({ recycle: true, reason: '干净归档（只有 git 历史）' });
  });

  it('HEAD 不在远端就留着', async () => {
    const dir = makeArchive('worktree-unpushed', receipt('deadbeef'));
    const facts = await readArchiveFacts(dir);
    expect(await judgeArchive(facts, deps({ isHeadPushed: async () => false }))).toEqual({
      recycle: false,
      reason: 'HEAD 不在远端',
    });
  });

  it('HEAD 在不在远端查不成也留着（不当成没事）', async () => {
    const dir = makeArchive('worktree-unknown', receipt('deadbeef'));
    const facts = await readArchiveFacts(dir);
    expect(await judgeArchive(facts, deps({ isHeadPushed: async () => undefined }))).toEqual({
      recycle: false,
      reason: 'HEAD 在不在远端查不成',
    });
  });

  it('工作区等于 HEAD 就回收', async () => {
    const dir = makeArchive('worktree-same', stateWith('deadbeef', [{ path: 'a.ts', sha256: 'aaa' }]));
    const facts = await readArchiveFacts(dir);
    expect(await judgeArchive(facts, deps())).toEqual({
      recycle: true,
      reason: 'HEAD 已在远端，工作区等于 HEAD',
    });
  });

  it('有未提交内容（改了）就留着', async () => {
    const dir = makeArchive('worktree-dirty', stateWith('deadbeef', [{ path: 'a.ts', sha256: 'changed' }]));
    const facts = await readArchiveFacts(dir);
    expect(await judgeArchive(facts, deps())).toEqual({
      recycle: false,
      reason: '有未提交内容（缺 0 改 1）',
    });
  });

  it('有未提交内容（HEAD 树里没有这个路径）就留着', async () => {
    const dir = makeArchive('worktree-new-file', stateWith('deadbeef', [{ path: 'b.ts', sha256: 'bbb' }]));
    const facts = await readArchiveFacts(dir);
    expect(await judgeArchive(facts, deps())).toEqual({
      recycle: false,
      reason: '有未提交内容（缺 1 改 0）',
    });
  });

  it('带 stash 或没做完的合并不回收（bundle 带不走）', async () => {
    const withMerge = makeArchive(
      'worktree-merge',
      stateWith('deadbeef', [{ path: 'a.ts', sha256: 'aaa' }], { merge: 1 }),
    );
    expect(await judgeArchive(await readArchiveFacts(withMerge), deps())).toEqual({
      recycle: false,
      reason: '带 stash 或没做完的 git 操作（1 项）',
    });
    const withStash = makeArchive(
      'worktree-stash',
      stateWith('deadbeef', [{ path: 'a.ts', sha256: 'aaa' }], { stash: 2 }),
    );
    expect((await judgeArchive(await readArchiveFacts(withStash), deps())).recycle).toBe(false);
  });

  it('HEAD 树取不出就留着', async () => {
    const dir = makeArchive('worktree-nobundle', stateWith('deadbeef', [{ path: 'a.ts', sha256: 'aaa' }]));
    const facts = await readArchiveFacts(dir);
    expect(await judgeArchive(facts, deps({ readHeadTree: async () => undefined }))).toEqual({
      recycle: false,
      reason: 'HEAD 树取不出',
    });
  });

  it('结构认不出就留着', async () => {
    const dir = makeArchive('worktree-weird', { 'weird.txt': 'x' });
    const facts = await readArchiveFacts(dir);
    expect(facts.shape).toBe('empty');
    expect((await judgeArchive(facts, deps())).recycle).toBe(false);
  });

  it('空目录回收', async () => {
    const dir = join(root, 'worktree-empty');
    mkdirSync(dir);
    const facts = await readArchiveFacts(dir);
    expect(await judgeArchive(facts, deps())).toEqual({ recycle: true, reason: '空目录' });
  });
});

describe('回收一轮', () => {
  const DAY = 24 * 3600 * 1000;
  const NOW = 1_700_000_000_000;

  it('过保留期的先清，不到期的不动', async () => {
    const old = makeArchive('worktree-old', { ...receipt('aaaa'), 'recovery.bundle': 'x' });
    const fresh = makeArchive('worktree-fresh', { ...receipt('bbbb'), 'recovery.bundle': 'x' });
    // 造出 mtime 差别：保留期 14 天
    const { utimesSync } = await import('node:fs');
    utimesSync(old, new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY));
    utimesSync(fresh, new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));

    const result = await recycleArchives(deps({ now: () => NOW }), ARCHIVE_RETENTION_LIMITS);
    expect(result.removed.map((r) => r.dir)).toEqual([old]);
    expect(result.kept).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it('超上限时按最老优先清到放得下', async () => {
    const { utimesSync } = await import('node:fs');
    const dirs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const d = makeArchive(`worktree-big${i}`, { ...receipt(`head${i}`), 'recovery.bundle': 'x' });
      // 每个 1MB
      writeFileSync(join(d, 'blob.bin'), Buffer.alloc(1024 * 1024));
      utimesSync(d, new Date(NOW - (10 - i) * DAY), new Date(NOW - (10 - i) * DAY));
      dirs.push(d);
    }
    // 上限设成 1.5MB，只能留一个
    const limits = { keepDays: 30, archiveMaxBytes: 1.5 * 1024 * 1024 };
    const result = await recycleArchives(deps({ now: () => NOW }), limits);
    expect(result.removed.length).toBeGreaterThanOrEqual(2);
    expect(result.bytesKept).toBeLessThanOrEqual(limits.archiveMaxBytes);
    // 最老的两个被清
    expect(result.removed.map((r) => r.dir)).toContain(dirs[0]);
  });

  it('判不清的不清，记进 failures 不算跑成', async () => {
    const dir = makeArchive('worktree-keep', { ...receipt('cccc'), 'recovery.bundle': 'x' });
    const { utimesSync } = await import('node:fs');
    utimesSync(dir, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
    const result = await recycleArchives(
      deps({ now: () => NOW, isHeadPushed: async () => undefined }),
      ARCHIVE_RETENTION_LIMITS,
    );
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
  });

  it('归档根目录列不出时明确失败，不当成没有', async () => {
    // 根目录不存在 = 还没归档过，不算失败（新装的机器就这样）
    const missing = await recycleArchives(
      deps({ archiveDir: join(root, 'missing') }),
      ARCHIVE_RETENTION_LIMITS,
    );
    expect(missing).toEqual({ removed: [], kept: 0, bytesKept: 0, failures: [] });
    // 列不出（不是不存在，是读不成）才失败
    const notADir = join(root, 'not-a-dir');
    writeFileSync(notADir, 'x');
    await expect(recycleArchives(deps({ archiveDir: notADir }), ARCHIVE_RETENTION_LIMITS)).rejects.toThrow();
  });
});
