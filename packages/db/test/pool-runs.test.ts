// 账号池上的会话两张表并起来读（pool-runs.ts）：近几天结束的（熔断、战绩）、花了多少（估算类池的用量）、还开着的带路由
// （熔断半开数在途的试探）。Fusion 的会话（session_runs）和三段的一次性会话（runs）都要在；runs 读不了明确报错（#758）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { endedPoolRuns, openPoolRuns, poolRunUsage } from '../src/queries/pool-runs.ts';
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

const oneShot = { model: 'opus-5.5' } as const;

/** 报的错是读 runs 读出来的：drizzle 外面包了一层「Failed query」，原来那句在 cause 里。 */
async function expectRunsUnreadable(read: Promise<unknown>): Promise<void> {
  const err = await read.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'runs 读不了却照常回了结果（只剩 Fusion 那一半）').not.toBeNull();
  const messages: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join('\n')).toContain('relation "runs" does not exist');
}

/** 把 runs 挪开再跑 read（查它就报错，和库断在这一步一样），跑完挪回来。 */
async function withRunsUnreadable(read: () => Promise<unknown>): Promise<void> {
  await t.client.exec('alter table runs rename to runs_unreadable');
  try {
    await expectRunsUnreadable(read());
  } finally {
    await t.client.exec('alter table runs_unreadable rename to runs');
  }
}

describe('endedPoolRuns：近几天结束的会话，两张表都算（熔断、战绩）', () => {
  it('Fusion 的会话带阶段、三段的一次性会话带是哪一段，各带算不算路由的账；按结束先后排；没结束的、太早的、runs 里没写路由的不算', async () => {
    const task = await addTask(t.db, (await addRepo(t.db)).id);
    const fusion = await addRun(t.db, {
      taskId: task.id,
      routeId: 'a-opus',
      queuedAt: ago(55 * MIN),
      startedAt: ago(50 * MIN),
      endedAt: ago(40 * MIN),
      outcome: 'failed',
      routeOutcome: 'fail',
    });
    // 太早（since 之前结束的）
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'a-opus',
      queuedAt: ago(5 * HOUR),
      startedAt: ago(5 * HOUR),
      endedAt: ago(4 * HOUR),
      outcome: 'ok',
      routeOutcome: 'ok',
    });
    // 还在跑的 Fusion 会话
    await addRun(t.db, { taskId: task.id, routeId: 'a-opus', startedAt: ago(10 * MIN) });
    const manual = randomUUID();
    await startRun(t.db, {
      ...oneShot,
      id: manual,
      segment: 'manual',
      routeId: 'a-opus',
      startedAt: ago(30 * MIN),
      endedAt: ago(20 * MIN),
      outcome: 'failed',
      routeOutcome: 'fail',
    });
    const verify = randomUUID();
    await startRun(t.db, {
      ...oneShot,
      id: verify,
      segment: 'verify',
      routeId: 'b-opus',
      startedAt: ago(15 * MIN),
      endedAt: ago(5 * MIN),
      outcome: 'done',
      routeOutcome: 'ok',
    });
    // 老行：收了场、没下过「算不算路由的账」的结论
    const old = randomUUID();
    await startRun(t.db, {
      ...oneShot,
      id: old,
      segment: 'manual',
      routeId: 'b-opus',
      startedAt: ago(12 * MIN),
      endedAt: ago(11 * MIN),
      outcome: 'done',
    });
    // 还在跑的一次性会话、没写路由的一次性会话、太早结束的一次性会话
    await startRun(t.db, { ...oneShot, segment: 'manual', routeId: 'a-opus', startedAt: ago(2 * MIN) });
    await startRun(t.db, {
      ...oneShot,
      segment: 'scope',
      startedAt: ago(9 * MIN),
      endedAt: ago(8 * MIN),
      outcome: 'failed',
      routeOutcome: 'fail',
    });
    await startRun(t.db, {
      ...oneShot,
      segment: 'manual',
      routeId: 'a-opus',
      startedAt: ago(3 * HOUR),
      endedAt: ago(2 * HOUR),
      outcome: 'failed',
      routeOutcome: 'fail',
    });

    expect(await endedPoolRuns(t.db, ago(HOUR))).toEqual([
      {
        kind: 'session',
        runId: fusion.id,
        routeId: 'a-opus',
        stage: 'execute',
        endedAt: ago(40 * MIN),
        routeOutcome: 'fail',
      },
      {
        kind: 'oneShot',
        runId: manual,
        routeId: 'a-opus',
        segment: 'manual',
        endedAt: ago(20 * MIN),
        routeOutcome: 'fail',
      },
      {
        kind: 'oneShot',
        runId: old,
        routeId: 'b-opus',
        segment: 'manual',
        endedAt: ago(11 * MIN),
        routeOutcome: null,
      },
      {
        kind: 'oneShot',
        runId: verify,
        routeId: 'b-opus',
        segment: 'verify',
        endedAt: ago(5 * MIN),
        routeOutcome: 'ok',
      },
    ]);
  });

  it('【故意造出的失败】runs 读不了：明确报错，不当成没有三段的会话、只交回 Fusion 那一半', async () => {
    const task = await addTask(t.db, (await addRepo(t.db)).id);
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'a-opus',
      startedAt: ago(30 * MIN),
      endedAt: ago(20 * MIN),
      outcome: 'failed',
      routeOutcome: 'fail',
    });
    await withRunsUnreadable(() => endedPoolRuns(t.db, ago(HOUR)));
  });
});

describe('poolRunUsage：估算类的池的用量，两张表都算', () => {
  it('只要这个池、时间范围内开始了的；三段会话记下的 token、花费在里面；花费为空的照样返回、字段为空，不拿 0 顶', async () => {
    const task = await addTask(t.db, (await addRepo(t.db)).id);
    const fusion = (routeId: string, over: Record<string, unknown>) =>
      addRun(t.db, { taskId: task.id, routeId, ...over });
    await fusion('a-opus', { startedAt: ago(10 * MIN), inputTokens: 100, costUsd: 0.25 });
    await fusion('a-opus', { startedAt: ago(5 * MIN) }); // 没记到花费
    await fusion('a-opus', { queuedAt: ago(4 * HOUR), startedAt: ago(3 * HOUR), costUsd: 9 }); // 范围外
    await fusion('a-opus', {}); // 还在排队、没开始
    await fusion('b-opus', { startedAt: ago(10 * MIN), costUsd: 7 }); // 别的池
    await startRun(t.db, {
      ...oneShot,
      segment: 'manual',
      routeId: 'a-opus',
      startedAt: ago(30 * MIN),
      endedAt: ago(20 * MIN),
      outcome: 'done',
      routeOutcome: 'ok',
      inputTokens: 2000,
      outputTokens: 300,
      cacheReadTokens: 50,
      cacheWriteTokens: 7,
      costUsd: 1.5,
    });
    // 三段会话没记到花费（执行体没报）：照样返回、花费为空
    await startRun(t.db, {
      ...oneShot,
      segment: 'verify',
      routeId: 'a-opus',
      startedAt: ago(15 * MIN),
      endedAt: ago(14 * MIN),
      outcome: 'failed',
      routeOutcome: 'fail',
      inputTokens: 40,
    });
    // 别的池、范围外、没写路由的一次性会话都不算
    await startRun(t.db, { ...oneShot, segment: 'manual', routeId: 'b-opus', startedAt: ago(9 * MIN) });
    await startRun(t.db, {
      ...oneShot,
      segment: 'manual',
      routeId: 'a-opus',
      startedAt: ago(2 * HOUR),
      endedAt: ago(90 * MIN),
      outcome: 'done',
      routeOutcome: 'ok',
      costUsd: 30,
    });
    await startRun(t.db, { ...oneShot, segment: 'scope', startedAt: ago(8 * MIN), costUsd: 4 });

    const rows = await poolRunUsage(t.db, { poolId: 'relay-a', since: ago(HOUR), until: NOW });
    expect(
      rows.map((r) => [
        r.kind,
        r.modelId,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.costUsd,
      ]),
    ).toEqual([
      ['oneShot', 'opus-5.5', 2000, 300, 50, 7, 1.5],
      ['oneShot', 'opus-5.5', 40, null, null, null, null],
      ['session', 'opus-5.5', 100, null, null, null, 0.25],
      ['session', 'opus-5.5', null, null, null, null, null],
    ]);
    expect(rows.map((r) => r.startedAt)).toEqual([ago(30 * MIN), ago(15 * MIN), ago(10 * MIN), ago(5 * MIN)]);
  });

  it('【故意造出的失败】runs 读不了：明确报错，估算不拿 Fusion 那一半当全部', async () => {
    const task = await addTask(t.db, (await addRepo(t.db)).id);
    await addRun(t.db, { taskId: task.id, routeId: 'a-opus', startedAt: ago(10 * MIN), costUsd: 0.25 });
    await withRunsUnreadable(() => poolRunUsage(t.db, { poolId: 'relay-a', since: ago(HOUR), until: NOW }));
  });
});

describe('openPoolRuns：还开着的带上路由（熔断半开时按路由数在途的试探）', () => {
  it('两种会话都带路由和池', async () => {
    const task = await addTask(t.db, (await addRepo(t.db)).id);
    const fusion = await addRun(t.db, { taskId: task.id, routeId: 'b-opus', startedAt: ago(10 * MIN) });
    const manual = randomUUID();
    await startRun(t.db, {
      ...oneShot,
      id: manual,
      segment: 'manual',
      routeId: 'a-opus',
      startedAt: ago(5 * MIN),
    });
    expect(
      (await openPoolRuns(t.db)).map((r) => [r.kind, r.runId, r.routeId, r.poolId, r.startedAt]),
    ).toEqual([
      ['session', fusion.id, 'b-opus', 'relay-b', ago(10 * MIN)],
      ['oneShot', manual, 'a-opus', 'relay-a', ago(5 * MIN)],
    ]);
  });
});
