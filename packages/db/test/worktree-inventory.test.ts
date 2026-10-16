// 工作树清单和一键清理的操作记录（#1993）：清单覆盖写、读回认得出；库里那份坏了明确报错；
// 清理的三种记录读得回；每棵树最近一次会话取收场时刻（没收场取起的时刻）。
import { foldCleanupRequests, WORKTREE_ACTION, type WorktreeInventory } from '@fleet-dao/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  lastSessionByTree,
  readWorktreeInventory,
  recordWorktreeCleanupDone,
  recordWorktreeCleanupRequest,
  recordWorktreeCleanupStart,
  saveWorktreeInventory,
  worktreeAuditRows,
} from '../src/queries/worktree-inventory.ts';
import { worktreeInventory } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, catalog } from './helpers.ts';

const NOW = new Date('2026-10-13T08:00:00.000Z');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

function inventory(over: Partial<WorktreeInventory> = {}): WorktreeInventory {
  return {
    takenAt: NOW.toISOString(),
    trigger: 'hourly',
    root: '/var/lib/fleet-work',
    trees: [
      {
        repo: 'acme/web',
        tree: '14-c',
        what: '需求 #14 的子任务「c」',
        issueNumber: 14,
        state: 'leftover',
        why: '没人用了，但里面还有：没推的提交 1 个',
        size: { state: 'ok', bytes: 1024 },
      },
    ],
    removed: ['acme_web/16-e'],
    repos: [{ repo: 'acme/web', mirror: { state: 'ok', bytes: 2048 } }],
    unchecked: [],
    ...over,
  };
}

describe('工作树清单', () => {
  it('没存过是 null；存了读得回；再存整份覆盖', async () => {
    expect(await readWorktreeInventory(t.db)).toBeNull();
    await saveWorktreeInventory(t.db, inventory());
    expect(await readWorktreeInventory(t.db)).toEqual(inventory());
    await saveWorktreeInventory(t.db, inventory({ trigger: 'cleanup', trees: [], removed: [] }));
    expect(await readWorktreeInventory(t.db)).toMatchObject({ trigger: 'cleanup', trees: [] });
    expect(await t.db.select().from(worktreeInventory)).toHaveLength(1);
  });

  it('【故意造出库里那份坏了】读回明确报错，不当成没有', async () => {
    await t.db.insert(worktreeInventory).values({ key: 'latest', takenAt: NOW, payload: { trees: 'x' } });
    await expect(readWorktreeInventory(t.db)).rejects.toThrow(/认不出/);
  });
});

describe('一键清理的操作记录', () => {
  it('点了、接手、清完都读得回，折出来是 done 带删了哪些、拒了哪些', async () => {
    await recordWorktreeCleanupRequest(t.db, {
      requestId: 'r1',
      actorId: 'ops:worktrees',
      reason: '试',
      at: NOW,
    });
    await recordWorktreeCleanupStart(t.db, { requestId: 'r1', at: new Date(NOW.getTime() + 1_000) });
    await recordWorktreeCleanupDone(t.db, {
      requestId: 'r1',
      at: new Date(NOW.getTime() + 2_000),
      ok: true,
      result: {
        removed: ['acme_web/16-e'],
        refused: [{ tree: 'acme_web/14-c', state: 'leftover', why: '没推的提交 1 个' }],
        unchecked: [],
      },
    });
    const rows = await worktreeAuditRows(t.db, new Date(NOW.getTime() - 1_000));
    expect(rows.map((r) => r.action).sort()).toEqual(
      [WORKTREE_ACTION.done, WORKTREE_ACTION.request, WORKTREE_ACTION.start].sort(),
    );
    const view = foldCleanupRequests(rows, new Date(NOW.getTime() + 3_000)).requests[0];
    expect(view).toMatchObject({ status: 'done', by: 'ops:worktrees' });
    expect(view?.result?.refused[0]?.why).toContain('没推的提交');
  });

  it('【故意造出没做成却不写原因】拒写', async () => {
    await expect(
      recordWorktreeCleanupDone(t.db, { requestId: 'r1', at: NOW, ok: false, error: '  ' }),
    ).rejects.toThrow(/没写为什么/);
  });
});

describe('每棵树最近一次会话', () => {
  it('收场了取收场时刻，没收场取起的时刻；同一棵树取最新', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    const repo = await addRepo(t.db, 'web');
    const task = await addTask(t.db, repo.id, { issueNumber: 14 });
    const a = '/var/lib/fleet-work/acme_web/14-c';
    const b = '/var/lib/fleet-work/acme_web/15-d';
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'r1',
      worktreePath: a,
      startedAt: new Date('2026-10-10T07:00:00.000Z'),
      endedAt: new Date('2026-10-10T08:00:00.000Z'),
      outcome: 'done',
    });
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'r1',
      worktreePath: a,
      startedAt: new Date('2026-10-11T07:00:00.000Z'),
      endedAt: new Date('2026-10-11T09:00:00.000Z'),
      outcome: 'done',
    });
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'r1',
      worktreePath: b,
      startedAt: new Date('2026-10-12T07:00:00.000Z'),
    });
    const got = await lastSessionByTree(t.db);
    expect(got.get(a)?.toISOString()).toBe('2026-10-11T09:00:00.000Z');
    expect(got.get(b)?.toISOString()).toBe('2026-10-12T07:00:00.000Z');
  });
});
