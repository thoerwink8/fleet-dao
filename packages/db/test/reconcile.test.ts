import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activeTaskRefs, reconcileRepos } from '../src/queries/reconcile.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, HOUR, MIN } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

describe('每小时对账要的两份清单', () => {
  it('没结束的单都列出来（含排队），终态的不列；仓和最近更新带着', async () => {
    const aaa = await addRepo(t.db, 'aaa');
    const bbb = await addRepo(t.db, 'bbb');
    await addTask(t.db, aaa.id, { issueNumber: 1, state: 'done', updatedAt: ago(HOUR) });
    const running = await addTask(t.db, aaa.id, {
      issueNumber: 2,
      state: 'running',
      updatedAt: ago(2 * HOUR),
    });
    const queued = await addTask(t.db, aaa.id, { issueNumber: 3, state: 'queued' });
    await addTask(t.db, bbb.id, { issueNumber: 4, state: 'failed' });
    const planning = await addTask(t.db, bbb.id, {
      issueNumber: 5,
      state: 'planning',
      updatedAt: ago(MIN),
    });
    await addTask(t.db, bbb.id, { issueNumber: 6, state: 'stopped' });

    const rows = await activeTaskRefs(t.db);
    expect(rows.map((r) => [r.name, r.issueNumber, r.state, r.taskId])).toEqual([
      ['aaa', 2, 'running', running.id],
      ['aaa', 3, 'queued', queued.id],
      ['bbb', 5, 'planning', planning.id],
    ]);
    expect(rows.map((r) => r.owner)).toEqual(['acme', 'acme', 'acme']);
    expect(rows[0]?.updatedAt).toEqual(ago(2 * HOUR));
    expect(rows[1]?.updatedAt).toBeNull();
    expect(rows[2]?.updatedAt).toEqual(ago(MIN));

    expect(await reconcileRepos(t.db)).toEqual([
      { owner: 'acme', name: 'aaa' },
      { owner: 'acme', name: 'bbb' },
    ]);
  });
});
