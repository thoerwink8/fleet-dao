// 拉单挑单读的历史（queries/intake-history.ts，#1336）：失败几次、一小时内起了几条、最近结束的几条、熔断状态。
// 读不出的形状照抛，不当成「正常」。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  firstTaskCreatedSince,
  INTAKE_BREAKER_SETTING,
  readIntakeBreaker,
  recentEndedTasks,
  taskFailureCount,
  tasksCreatedSince,
  writeIntakeBreaker,
} from '../src/queries/intake-history.ts';
import { settings, stateChanges } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, HOUR, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

/** 补一条状态变化记录（触发器记的是真实时钟，测试要定死时刻）。 */
async function change(
  taskId: string,
  toState: 'done' | 'failed',
  at: Date,
  entity: 'task' | 'subtask' = 'task',
) {
  await t.db
    .insert(stateChanges)
    .values({ entity, entityId: taskId, taskId, fromState: 'running', toState, at });
}

describe('这张单失败过几次', () => {
  it('只数这张单任务行的 task 级 failed；别的单、子任务的失败、没有任务行都不算', async () => {
    const repo = await addRepo(t.db, 'aaa');
    const other = await addRepo(t.db, 'bbb');
    const mine = await addTask(t.db, repo.id, { issueNumber: 7 });
    const same = await addTask(t.db, other.id, { issueNumber: 7 });
    await change(mine.id, 'failed', ago(3 * HOUR));
    await change(mine.id, 'failed', ago(HOUR));
    await change(mine.id, 'done', ago(MIN));
    await change(mine.id, 'failed', ago(MIN), 'subtask');
    await change(same.id, 'failed', ago(HOUR));
    expect(await taskFailureCount(t.db, repo.id, 7)).toBe(2);
    expect(await taskFailureCount(t.db, other.id, 7)).toBe(1);
    expect(await taskFailureCount(t.db, repo.id, 8)).toBe(0);
  });
});

describe('一小时内起了几条', () => {
  it('按任务行的建出时刻数，不早于 since 的才算', async () => {
    const repo = await addRepo(t.db, 'aaa');
    await addTask(t.db, repo.id, { createdAt: ago(61 * MIN) });
    await addTask(t.db, repo.id, { createdAt: ago(59 * MIN) });
    await addTask(t.db, repo.id, { createdAt: ago(MIN) });
    expect(await tasksCreatedSince(t.db, ago(HOUR))).toBe(2);
  });
});

describe('最近结束的任务', () => {
  it('只要 done / failed，新的在前；叫停和子任务不算；after 之后的才要；limit 生效', async () => {
    const repo = await addRepo(t.db, 'aaa');
    const a = await addTask(t.db, repo.id);
    const b = await addTask(t.db, repo.id);
    await change(a.id, 'failed', ago(5 * HOUR));
    await change(b.id, 'done', ago(4 * HOUR));
    await change(a.id, 'failed', ago(3 * HOUR));
    await change(b.id, 'failed', ago(HOUR), 'subtask');
    // 叫停：触发器写的 stopped 不在 done/failed 里
    await t.db.insert(stateChanges).values({
      entity: 'task',
      entityId: b.id,
      taskId: b.id,
      fromState: 'running',
      toState: 'stopped',
      at: ago(2 * HOUR),
    });
    const all = await recentEndedTasks(t.db, { limit: 6 });
    expect(all.map((r) => r.state)).toEqual(['failed', 'done', 'failed']);
    expect(all[0]?.endedAt.toISOString()).toBe(ago(3 * HOUR).toISOString());
    const after = await recentEndedTasks(t.db, { limit: 6, after: ago(4 * HOUR + MIN) });
    expect(after.map((r) => r.state)).toEqual(['failed', 'done']);
    expect(await recentEndedTasks(t.db, { limit: 1 })).toHaveLength(1);
  });
});

describe('熔断试探的那一条', () => {
  it('从 since 起建出来的第一条；没有是 null', async () => {
    const repo = await addRepo(t.db, 'aaa');
    await addTask(t.db, repo.id, { createdAt: ago(3 * HOUR), state: 'running' });
    const first = await addTask(t.db, repo.id, { createdAt: ago(30 * MIN), state: 'running' });
    await addTask(t.db, repo.id, { createdAt: ago(10 * MIN) });
    expect(await firstTaskCreatedSince(t.db, ago(HOUR))).toMatchObject({ id: first.id, state: 'running' });
    expect(await firstTaskCreatedSince(t.db, NOW)).toBeNull();
  });
});

describe('熔断状态（设置表）', () => {
  it('没写过是 null；写了读回；再写版本加 1、值换掉', async () => {
    expect(await readIntakeBreaker(t.db)).toBeNull();
    await writeIntakeBreaker(t.db, { state: 'open', at: ago(HOUR), by: 'engine:intake' });
    expect(await readIntakeBreaker(t.db)).toEqual({ state: 'open', at: ago(HOUR) });
    await writeIntakeBreaker(t.db, { state: 'closed', at: NOW, by: 'engine:intake' });
    expect(await readIntakeBreaker(t.db)).toEqual({ state: 'closed', at: NOW });
    const [row] = await t.db.select().from(settings);
    expect(row?.version).toBe(2);
  });

  it('【故意造出的失败】这一行的形状认不出：抛错，不当成正常', async () => {
    await t.db.insert(settings).values({ key: INTAKE_BREAKER_SETTING, value: { state: 'half', at: 'x' } });
    await expect(readIntakeBreaker(t.db)).rejects.toThrow(/认不出/);
  });
});
