// 拼车池的并发上限和窗口里本机记到的花费（queries/carpool-spend.ts，#194 方案 4.7）：只认带组织类型 carpool 的池；
// 花费没记到的会话单独数、不当 0 美元；读不了照常抛。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { carpoolApiWindow, carpoolPoolCaps, carpoolWindowSpend } from '../src/queries/carpool-spend.ts';
import { startRun } from '../src/queries/runs.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addTask,
  addWindow,
  ago,
  catalog,
  HOUR,
  later,
  MIN,
  NOW,
} from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await addRoute(t.db, { id: 'a-opus', poolId: 'relay-a', modelId: 'opus-5.5' });
  await addRoute(t.db, { id: 'b-opus', poolId: 'relay-b', modelId: 'opus-5.5' });
});

const asCarpool = (poolId: string) =>
  t.client.query(
    `update pools set org_kind = 'carpool', run_as_user = 'fleet-agent-carpool' where id = '${poolId}'`,
  );

describe('carpoolPoolCaps：库里拼车池的并发上限', () => {
  it('一个拼车池都没有回空数组（不当成上限 0），有几个列几个、按池编号排', async () => {
    expect(await carpoolPoolCaps(t.db)).toEqual([]);
    await asCarpool('relay-b');
    await asCarpool('relay-a');
    expect(await carpoolPoolCaps(t.db)).toEqual([
      { poolId: 'relay-a', maxConcurrency: 2 },
      { poolId: 'relay-b', maxConcurrency: 1 },
    ]);
  });

  it('【故意造出的失败】pools 读不了：照常抛，不回空数组冒充「没有拼车池」', async () => {
    await t.client.exec('alter table pools rename to pools_unreadable');
    try {
      await expect(carpoolPoolCaps(t.db)).rejects.toThrow();
    } finally {
      await t.client.exec('alter table pools_unreadable rename to pools');
    }
  });
});

describe('carpoolWindowSpend：窗口里本机记到的拼车花费', () => {
  it('只算拼车池、窗口内开始的；花费为空的单独数，被切号停下的再单独数', async () => {
    await asCarpool('relay-a');
    const task = await addTask(t.db, (await addRepo(t.db)).id);
    await addRun(t.db, { taskId: task.id, routeId: 'a-opus', startedAt: ago(30 * MIN), costUsd: 1.25 });
    await addRun(t.db, { taskId: task.id, routeId: 'a-opus', startedAt: ago(20 * MIN) }); // 没记到花费
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'a-opus',
      queuedAt: ago(7 * HOUR),
      startedAt: ago(6 * HOUR),
      costUsd: 50,
    }); // 窗口外
    await addRun(t.db, { taskId: task.id, routeId: 'b-opus', startedAt: ago(10 * MIN), costUsd: 7 }); // 不是拼车池
    await addRun(t.db, { taskId: task.id, routeId: 'a-opus' }); // 还在排队、没开始
    await startRun(t.db, {
      model: 'opus-5.5',
      segment: 'manual',
      routeId: 'a-opus',
      startedAt: ago(15 * MIN),
      endedAt: ago(10 * MIN),
      outcome: 'done',
      routeOutcome: 'ok',
      costUsd: 0.75,
    });
    await startRun(t.db, {
      model: 'opus-5.5',
      segment: 'verify',
      routeId: 'a-opus',
      startedAt: ago(12 * MIN),
      endedAt: ago(11 * MIN),
      outcome: 'org_switch',
      routeOutcome: 'neutral',
    });
    const s = await carpoolWindowSpend(t.db, { since: ago(5 * HOUR), until: NOW });
    expect(s).toEqual({
      sessions: 4,
      recordedUsd: 2,
      recorded: 2,
      unrecorded: 2,
      unrecordedSwitchStopped: 1,
    });
  });

  it('给了 poolId 只算这个池：两个拼车池各自的花费不混在一起（第二意见第 2 轮）', async () => {
    await asCarpool('relay-a');
    await asCarpool('relay-b');
    const task = await addTask(t.db, (await addRepo(t.db)).id);
    await addRun(t.db, { taskId: task.id, routeId: 'a-opus', startedAt: ago(30 * MIN), costUsd: 3 });
    await addRun(t.db, { taskId: task.id, routeId: 'b-opus', startedAt: ago(20 * MIN), costUsd: 5 });
    const q = { since: ago(5 * HOUR), until: NOW };
    expect((await carpoolWindowSpend(t.db, q)).recordedUsd).toBe(8);
    expect((await carpoolWindowSpend(t.db, { ...q, poolId: 'relay-a' })).recordedUsd).toBe(3);
    expect((await carpoolWindowSpend(t.db, { ...q, poolId: 'relay-b' })).recordedUsd).toBe(5);
    expect((await carpoolWindowSpend(t.db, { ...q, poolId: 'nope' })).sessions).toBe(0);
  });

  it('窗口里一个会话都没有：全是 0（真的没有），不是认不出', async () => {
    await asCarpool('relay-a');
    expect(await carpoolWindowSpend(t.db, { since: ago(5 * HOUR), until: NOW })).toEqual({
      sessions: 0,
      recordedUsd: 0,
      recorded: 0,
      unrecorded: 0,
      unrecordedSwitchStopped: 0,
    });
  });

  it('【故意造出的失败】runs 读不了：照常抛，不拿 Fusion 那一半当全部花费', async () => {
    await asCarpool('relay-a');
    await t.client.exec('alter table runs rename to runs_unreadable');
    try {
      await expect(carpoolWindowSpend(t.db, { since: ago(5 * HOUR), until: NOW })).rejects.toThrow();
    } finally {
      await t.client.exec('alter table runs_unreadable rename to runs');
    }
  });
});

describe('carpoolApiWindow：接口读到的拼车 5 小时美元窗口', () => {
  const usd = (poolId: string, readAt: Date, used: number, over: Record<string, unknown> = {}) =>
    addWindow(t.db, {
      poolId,
      window: '5h',
      label: 'carpool_5h_usd',
      unit: 'usd',
      used,
      limit: 80,
      utilization: used / 80,
      resetsAt: later(2 * HOUR),
      reading: 'measured',
      source: 'reclaude-carpool',
      readAt,
      ...over,
    });

  it('没读到过回 null（不当成没用）；读到了回已用、上限、清零时刻；不是拼车池、不是接口读的、不是美元的都不算', async () => {
    await asCarpool('relay-a');
    expect(await carpoolApiWindow(t.db)).toBeNull();
    await usd('relay-b', ago(MIN), 9); // 不是拼车池
    await usd('relay-a', ago(2 * MIN), 20, { label: 'x_percent', unit: 'percent', source: 'claude-usage' }); // 不是接口的美元
    expect(await carpoolApiWindow(t.db)).toBeNull();
    await usd('relay-a', ago(3 * MIN), 31.5);
    expect(await carpoolApiWindow(t.db)).toEqual({
      poolId: 'relay-a',
      used: 31.5,
      limit: 80,
      resetsAt: later(2 * HOUR),
      readAt: ago(3 * MIN),
      staleSince: null,
      poolsWithWindow: 1,
    });
  });

  it('两个拼车池都读到了窗口：取读数最新的，并写明有 2 个池（对账据此说没法对）', async () => {
    await asCarpool('relay-a');
    await asCarpool('relay-b');
    await usd('relay-a', ago(5 * MIN), 10);
    await usd('relay-b', ago(MIN), 12);
    expect(await carpoolApiWindow(t.db)).toMatchObject({ poolId: 'relay-b', used: 12, poolsWithWindow: 2 });
  });
});
