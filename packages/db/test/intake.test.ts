// 引擎拉单从库里读的两样（queries/intake.ts）：受管的仓带开关、一张单的任务行状态。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listIntakeRepos, taskStateByIssue } from '../src/queries/intake.ts';
import { repos } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, DAY } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

describe('受管的仓（listIntakeRepos）', () => {
  it('开关开着的、关着的都列，按仓名排；开关打开的时刻带着，关着是 null', async () => {
    const b = await addRepo(t.db, 'bbb');
    const a = await addRepo(t.db, 'aaa');
    const opened = ago(DAY);
    await t.db.update(repos).set({ autoDispatchSince: opened }).where(eq(repos.id, b.id));
    const rows = await listIntakeRepos(t.db);
    expect(rows.map((r) => r.name)).toEqual(['aaa', 'bbb']);
    expect(rows[0]).toMatchObject({
      id: a.id,
      owner: 'acme',
      defaultBranch: 'main',
      testCommand: 'pnpm check',
      autoDispatchSince: null,
    });
    expect(rows[1]?.autoDispatchSince?.toISOString()).toBe(opened.toISOString());
  });

  it('一个仓都没有：空数组（调用方把它当「库里没有受管的仓」报，不当成都关着）', async () => {
    expect(await listIntakeRepos(t.db)).toEqual([]);
  });
});

describe('一张单的任务行（taskStateByIssue）', () => {
  it('有就回编号和状态；同一个号在另一个仓里的不串；没有是 null', async () => {
    const a = await addRepo(t.db, 'aaa');
    const b = await addRepo(t.db, 'bbb');
    const queued = await addTask(t.db, a.id, { issueNumber: 7, state: 'queued' });
    await addTask(t.db, b.id, { issueNumber: 7, state: 'done' });
    expect(await taskStateByIssue(t.db, a.id, 7)).toEqual({ id: queued.id, state: 'queued' });
    expect(await taskStateByIssue(t.db, b.id, 7)).toMatchObject({ state: 'done' });
    expect(await taskStateByIssue(t.db, a.id, 8)).toBeNull();
  });
});
