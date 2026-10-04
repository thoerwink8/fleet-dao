// 账号池上的会话两张表并起来读（pool-runs.ts）：近几天结束的（熔断、战绩）、花了多少（估算类池的用量）、还开着的带路由
// （熔断半开数在途的试探）。Fusion 的会话（session_runs）和三段的一次性会话（runs）都要在；runs 读不了明确报错（#758）。
// 三段的一段选定路由、还没开跑时预占着的名额（pool_reservations，#757）：锁住池再数再占，开跑那一行写进去时同一个事务里交接，
// 没开跑就放掉、过期不算；读不了、写不进去都明确报错。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  admitRun,
  clearReservations,
  endedPoolRuns,
  openPoolRuns,
  PoolFullError,
  type PoolReservationRequest,
  poolRunUsage,
  releaseReservation,
  releaseTaskReservation,
  reservePoolSlot,
} from '../src/queries/pool-runs.ts';
import { poolOccupancy } from '../src/queries/quota.ts';
import { getRun, startRun } from '../src/queries/runs.ts';
import { poolReservations } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, HOUR, later, MIN, NOW } from './helpers.ts';

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

describe('三段的一段选定路由、还没开跑时预占着的名额（pool_reservations，#757）', () => {
  /** 几张单（同一个仓）。 */
  const tasksOf = async (n: number): Promise<string[]> => {
    const repo = await addRepo(t.db);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push((await addTask(t.db, repo.id)).id);
    return out;
  };
  const three = async () => (await tasksOf(3)) as [string, string, string];
  /** 现在选中、20 分钟后过期的一次预占。 */
  const req = (
    taskId: string,
    routeId: string,
    over: Partial<PoolReservationRequest> = {},
  ): PoolReservationRequest => ({
    taskId,
    segment: 'manual',
    routeId,
    reservedAt: NOW,
    expiresAt: later(20 * MIN),
    ...over,
  });
  /** 40 分钟前占的、20 分钟前就过期了的一次预占。 */
  const lapsed = { reservedAt: ago(40 * MIN), expiresAt: ago(20 * MIN) };
  /** 预占上了，交回编号；没占上直接让用例红（夹具写错了）。 */
  const reserved = async (r: PoolReservationRequest): Promise<string> => {
    const got = await reservePoolSlot(t.db, r);
    if (!got.reserved) throw new Error(`夹具：${r.taskId} 应该预占上了`);
    return got.reservationId;
  };
  /** 开跑那一行（动手段、还没结束）。 */
  const row = (id: string, routeId: string, over: { taskId?: string } = {}) => ({
    id,
    segment: 'manual' as const,
    model: 'opus-5.5',
    routeId,
    startedAt: later(MIN),
    ...(over.taskId ? { taskId: over.taskId } : {}),
  });
  const rows = () => t.db.select().from(poolReservations);

  it('openPoolRuns、poolOccupancy 数得到预占着的名额（算一次性会话、还没开工）；过了 expires_at 的不算', async () => {
    const [a, b] = await three();
    const id = await reserved(req(a, 'a-opus', { reservedAt: ago(2 * MIN) }));
    // 直接写一行过了期的（预占那一步会顺手收掉它，这里要它留在表里）
    await t.db
      .insert(poolReservations)
      .values({ taskId: b, segment: 'verify', routeId: 'b-opus', ...lapsed });
    const open = await openPoolRuns(t.db, { now: NOW });
    expect(open.map((r) => [r.kind, r.runId, r.routeId, r.poolId, r.queuedAt, r.startedAt])).toEqual([
      ['oneShot', id, 'a-opus', 'relay-a', ago(2 * MIN), null],
    ]);
    expect(Object.fromEntries(await poolOccupancy(t.db, { now: NOW }))).toEqual({
      'relay-a': { inFlight: 0, reserved: 1 },
    });
    // 那一行过期之前也算
    expect((await openPoolRuns(t.db, { now: ago(30 * MIN) })).map((r) => r.poolId).sort()).toEqual([
      'relay-a',
      'relay-b',
    ]);
  });

  it('锁住池再数再占：上限 2 的池两张单占上，第三张占不上（reserved: false、写明数到几个）；在跑的、Fusion 排着的一样占名额；同一张单再选路是换掉自己的那个', async () => {
    const [a, b, c] = await three();
    await reserved(req(a, 'a-opus'));
    await reserved(req(b, 'a-opus'));
    expect(await reservePoolSlot(t.db, req(c, 'a-opus'))).toEqual({
      reserved: false,
      poolId: 'relay-a',
      occupied: 2,
      maxConcurrency: 2,
      expired: [],
    });
    // a 重新选路（上一次没开跑）：换掉它自己那个，不算它在和自己抢，池上还是 2 个
    await reserved(req(a, 'a-opus', { reservedAt: later(MIN) }));
    expect(
      (await openPoolRuns(t.db, { now: later(MIN) })).filter((r) => r.poolId === 'relay-a'),
    ).toHaveLength(2);
    // relay-b 上限 1：一行开着的一次性会话占满，占不上；那一行收了、换一个 Fusion 排着还没开工的会话，照样占满
    const open = randomUUID();
    const opening = {
      ...oneShot,
      id: open,
      segment: 'manual' as const,
      routeId: 'b-opus',
      startedAt: ago(MIN),
    };
    await startRun(t.db, opening);
    expect(await reservePoolSlot(t.db, req(c, 'b-opus'))).toMatchObject({ reserved: false, occupied: 1 });
    await startRun(t.db, { ...opening, endedAt: NOW, outcome: 'done', routeOutcome: 'ok' });
    await addRun(t.db, { taskId: c, routeId: 'b-opus' });
    expect(await reservePoolSlot(t.db, req(c, 'b-opus'))).toMatchObject({ reserved: false, occupied: 1 });
  });

  it('几张单同时选路、同时预占：上限 2 的池只放进 2 个，别的都明确回占不上（不靠时间差碰运气）', async () => {
    const ids = await tasksOf(5);
    const results = await Promise.all(ids.map((id) => reservePoolSlot(t.db, req(id, 'a-opus'))));
    expect(results.filter((r) => r.reserved)).toHaveLength(2);
    expect(results.flatMap((r) => (r.reserved ? [] : [r.occupied]))).toEqual([2, 2, 2]);
    expect(await poolOccupancy(t.db, { now: NOW })).toEqual(
      new Map([['relay-a', { inFlight: 0, reserved: 2 }]]),
    );
  });

  it('过了期的预占不占名额：预占的时候顺手收掉、交回给调用方（那一段多半卡住了，要记一笔）', async () => {
    const [a, b, c] = await three();
    await reserved(req(a, 'a-opus', lapsed));
    expect(await reservePoolSlot(t.db, req(b, 'a-opus'))).toMatchObject({
      reserved: true,
      expired: [{ taskId: a, segment: 'manual', routeId: 'a-opus', reservedAt: ago(40 * MIN) }],
    });
    expect(await reservePoolSlot(t.db, req(c, 'a-opus'))).toMatchObject({ reserved: true, expired: [] });
    expect(await rows()).toHaveLength(2);
  });

  it('开跑那一行和预占在同一个事务里交接：池满着也照样开跑（名额本来就是它的），预占没了、开着的那一行在，池上占着的数不变', async () => {
    const [a, b] = await three();
    const mine = await reserved(req(a, 'a-opus'));
    await reserved(req(b, 'a-opus'));
    const runId = randomUUID();
    expect(await admitRun(t.db, row(runId, 'a-opus', { taskId: a }), { reservationId: mine })).toEqual({
      reservation: 'taken',
    });
    expect(await getRun(t.db, runId)).toMatchObject({ routeId: 'a-opus', taskId: a, endedAt: null });
    expect((await rows()).map((r) => r.taskId)).toEqual([b]);
    expect(await poolOccupancy(t.db, { now: later(2 * MIN) })).toEqual(
      new Map([['relay-a', { inFlight: 1, reserved: 1 }]]),
    );
  });

  it('【故意造出的失败】预占过期了、空位已经给了别的会话：开跑那一行不写，抛 PoolFullError（不当成还占着）；事务整个退回，预占原样留着', async () => {
    const [a, b, c] = await three();
    const stale = await reserved(req(a, 'a-opus', lapsed));
    // 不经预占那一步（它会顺手收掉过期的）：直接造两行开着的一次性会话占满 relay-a
    for (const [taskId, segment] of [
      [b, 'manual'],
      [c, 'verify'],
    ] as const) {
      await startRun(t.db, { ...oneShot, segment, routeId: 'a-opus', taskId, startedAt: ago(5 * MIN) });
    }
    const runId = randomUUID();
    const err = await admitRun(t.db, row(runId, 'a-opus', { taskId: a }), { reservationId: stale }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PoolFullError);
    expect(err).toMatchObject({ poolId: 'relay-a', occupied: 2, maxConcurrency: 2 });
    expect((err as PoolFullError).message).toContain('过期');
    expect(await getRun(t.db, runId)).toBeNull();
    expect((await rows()).map((r) => r.id)).toEqual([stale]);
  });

  it('预占过期了、池还有空位：按当时的空位排上（stale），照样开跑', async () => {
    const [a] = await three();
    const stale = await reserved(req(a, 'a-opus', lapsed));
    const runId = randomUUID();
    expect(await admitRun(t.db, row(runId, 'a-opus', { taskId: a }), { reservationId: stale })).toEqual({
      reservation: 'stale',
    });
    expect(await getRun(t.db, runId)).toMatchObject({ endedAt: null });
    expect(await rows()).toEqual([]);
  });

  it('【故意造出的失败】没预占就开跑（不经选路的老路子、预占已经被清掉）：池满了不让开跑、一行不写；同一个编号再开跑一次不和自己抢', async () => {
    const first = randomUUID();
    expect(await admitRun(t.db, row(first, 'b-opus'))).toEqual({ reservation: 'none' });
    expect(await admitRun(t.db, row(first, 'b-opus'))).toEqual({ reservation: 'none' });
    const second = randomUUID();
    await expect(admitRun(t.db, row(second, 'b-opus'))).rejects.toThrow(PoolFullError);
    await expect(admitRun(t.db, row(second, 'b-opus'), { reservationId: randomUUID() })).rejects.toThrow(
      '已经不在了',
    );
    expect(await getRun(t.db, second)).toBeNull();
  });

  it('没开跑就放掉（按预占的编号）、重新选路换掉旧的（按单子和段）、引擎重启整表清掉：放掉之后别的单占得上', async () => {
    const [a, b, c] = await three();
    const first = await reserved(req(a, 'a-opus'));
    await reserved(req(b, 'a-opus'));
    expect(await reservePoolSlot(t.db, req(c, 'a-opus'))).toMatchObject({ reserved: false });
    expect(await releaseReservation(t.db, first)).toBe(true);
    expect(await releaseReservation(t.db, first)).toBe(false);
    await reserved(req(c, 'a-opus'));
    expect(await releaseTaskReservation(t.db, { taskId: b, segment: 'manual' })).toBe(true);
    expect(await releaseTaskReservation(t.db, { taskId: b, segment: 'verify' })).toBe(false);
    expect(await clearReservations(t.db)).toEqual([
      { taskId: c, segment: 'manual', routeId: 'a-opus', reservedAt: NOW },
    ]);
    expect(await rows()).toEqual([]);
  });

  it('【故意造出的失败】预占读不了（把表挪开）：openPoolRuns、poolOccupancy 都明确报错，不当成池空着', async () => {
    const [a] = await three();
    await reserved(req(a, 'a-opus'));
    await t.client.exec('alter table pool_reservations rename to pool_reservations_unreadable');
    try {
      for (const read of [() => openPoolRuns(t.db, { now: NOW }), () => poolOccupancy(t.db, { now: NOW })]) {
        const err = await read().then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, 'pool_reservations 读不了却照常回了结果（当成没人占着）').not.toBeNull();
        const messages: string[] = [];
        for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
        expect(messages.join('\n')).toContain('relation "pool_reservations" does not exist');
      }
    } finally {
      await t.client.exec('alter table pool_reservations_unreadable rename to pool_reservations');
    }
  });

  it('【故意造出的失败】预占写不进去（单子库里没有、路由库里没有、过期时刻不晚于选中时刻）：明确抛错，一行不写', async () => {
    await expect(reservePoolSlot(t.db, req(randomUUID(), 'a-opus'))).rejects.toThrow();
    const [a] = await three();
    await expect(reservePoolSlot(t.db, req(a, 'no-such-route'))).rejects.toThrow(
      '库里没有路由 no-such-route',
    );
    await expect(reservePoolSlot(t.db, req(a, 'a-opus', { expiresAt: NOW }))).rejects.toThrow(
      '要晚于选中的时刻',
    );
    expect(await rows()).toEqual([]);
  });
});
