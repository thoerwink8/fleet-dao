// 拼车池的并发上限和窗口里本机记到的花费（queries/carpool-spend.ts，#194 方案 4.7）：只认带组织类型 carpool 的池；
// 花费没记到的会话单独数、不当 0 美元；读不了照常抛。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { carpoolPoolCaps, carpoolWindowSpend } from '../src/queries/carpool-spend.ts';
import { startRun } from '../src/queries/runs.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, HOUR, MIN, NOW } from './helpers.ts';

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
