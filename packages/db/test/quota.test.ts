import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inFlightByPool, quotaTable, upsertQuotaWindow, windowState } from '../src/queries/quota.ts';
import { pools, quotaWindows } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, HOUR, later, MIN, NOW } from './helpers.ts';

const reading = {
  utilization: null,
  used: null,
  limit: null,
  upstreamStatus: null,
  resetsAt: null,
  readAt: ago(MIN),
} as const;

describe('windowState：一个窗口现在能不能用', () => {
  it('有余就是 ok', () => {
    expect(windowState({ ...reading, utilization: 0.4, resetsAt: later(HOUR) }, NOW)).toBe('ok');
  });

  it('上游说满了就是满，哪怕按数字才用到 99%', () => {
    expect(
      windowState({ ...reading, used: 322156, limit: 325291, upstreamStatus: 'limit_reached' }, NOW),
    ).toBe('exhausted');
  });

  it('用量到顶、或利用率到 1，也是满', () => {
    expect(windowState({ ...reading, used: 400, limit: 400 }, NOW)).toBe('exhausted');
    expect(windowState({ ...reading, utilization: 1 }, NOW)).toBe('exhausted');
  });

  it('读数超过 30 分钟就不当现值：是「没查成」，不是「还够」', () => {
    expect(
      windowState(
        { ...reading, utilization: 0.1, readAt: ago(3 * HOUR), resetsAt: later(4 * 24 * HOUR) },
        NOW,
      ),
    ).toBe('stale');
    expect(windowState({ ...reading, utilization: 0.1, readAt: ago(31 * MIN) }, NOW)).toBe('stale');
    expect(windowState({ ...reading, utilization: 0.1, readAt: ago(29 * MIN) }, NOW)).toBe('ok');
  });

  it('已知清零时刻的「满」在清零前一直算满，读数旧了也一样', () => {
    expect(
      windowState(
        { ...reading, upstreamStatus: 'limit_reached', readAt: ago(2 * HOUR), resetsAt: later(HOUR) },
        NOW,
      ),
    ).toBe('exhausted');
    // 不知道什么时候清零，旧的「满」就说不准了。
    expect(windowState({ ...reading, upstreamStatus: 'limit_reached', readAt: ago(2 * HOUR) }, NOW)).toBe(
      'stale',
    );
  });

  it('过了清零时刻，旧读数作废', () => {
    expect(windowState({ ...reading, upstreamStatus: 'limit_reached', resetsAt: ago(MIN) }, NOW)).toBe(
      'reset',
    );
  });

  it('全程用传进来的时钟，不看墙钟', () => {
    const past = new Date('2020-01-01T00:00:00Z');
    expect(windowState({ ...reading, utilization: 0.1, readAt: past }, new Date(past.getTime() + MIN))).toBe(
      'ok',
    );
  });
});

describe('额度写入与额度表', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetTestDb(t);
    await catalog(t.db);
  });

  it('每个窗口各存一行：5h 快清零且几乎没用，调度看得到（不只存最紧的 7d）', async () => {
    await upsertQuotaWindow(t.db, {
      poolId: 'relay-a',
      window: '5h',
      used: 1140,
      limit: 143528,
      resetsAt: later(2 * HOUR).toISOString(),
      reading: 'measured',
      readAt: ago(MIN).toISOString(),
    });
    await upsertQuotaWindow(t.db, {
      poolId: 'relay-a',
      window: '7d',
      used: 285511,
      limit: 512600,
      resetsAt: later(4 * 24 * HOUR).toISOString(),
      reading: 'measured',
      readAt: ago(MIN).toISOString(),
    });
    const [relayA] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-a');
    expect(relayA?.windows.map((w) => w.window)).toEqual(['5h', '7d']);
    expect(relayA?.windows[0]?.remainingRatio).toBeCloseTo(0.992, 3);
    expect(relayA?.windows[0]?.resetsInMs).toBe(2 * HOUR);
  });

  it('上限每次都按最新读数算', async () => {
    const base = { poolId: 'relay-a', window: '5h', reading: 'measured' } as const;
    await upsertQuotaWindow(t.db, {
      ...base,
      used: 1000,
      limit: 171852,
      readAt: ago(20 * MIN).toISOString(),
    });
    await upsertQuotaWindow(t.db, { ...base, used: 1000, limit: 143528, readAt: ago(MIN).toISOString() });
    const rows = await t.db.select().from(quotaWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.limit).toBe(143528);
  });

  it('读很多次，行数不涨', async () => {
    for (let i = 0; i < 50; i++) {
      await upsertQuotaWindow(t.db, {
        poolId: 'relay-a',
        window: '7d',
        utilization: i / 100,
        reading: 'measured',
        readAt: ago((50 - i) * MIN).toISOString(),
      });
    }
    const rows = await t.db.select().from(quotaWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.utilization).toBe(0.49);
  });

  it('晚到的旧读数不覆盖新的', async () => {
    const base = { poolId: 'relay-a', window: '7d', reading: 'measured' } as const;
    expect(await upsertQuotaWindow(t.db, { ...base, utilization: 0.6, readAt: ago(MIN).toISOString() })).toBe(
      true,
    );
    expect(
      await upsertQuotaWindow(t.db, { ...base, utilization: 0.2, readAt: ago(HOUR).toISOString() }),
    ).toBe(false);
    const [row] = await t.db.select().from(quotaWindows);
    expect(row?.utilization).toBe(0.6);
  });

  it('账号级窗口和模型组窗口分开存，模型组名原样保留', async () => {
    await upsertQuotaWindow(t.db, {
      poolId: 'relay-a',
      window: '7d',
      utilization: 0.5,
      reading: 'measured',
      readAt: NOW.toISOString(),
    });
    await upsertQuotaWindow(t.db, {
      poolId: 'relay-a',
      window: '7d_model',
      scope: 'fable',
      upstreamStatus: 'limit_reached',
      reading: 'measured',
      readAt: NOW.toISOString(),
    });
    const [relayA] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-a');
    expect(relayA?.windows.map((w) => [w.window, w.scope, w.state])).toEqual(
      expect.arrayContaining([
        ['7d', null, 'ok'],
        ['7d_model', 'fable', 'exhausted'],
      ]),
    );
  });

  it('从没读到过额度的池也列出来，标「没查成」而不是「没有」', async () => {
    const table = await quotaTable(t.db, { now: NOW });
    expect(table.map((p) => [p.poolId, p.neverRead])).toEqual([
      ['relay-a', true],
      ['relay-b', true],
    ]);
  });

  it('每行写明实读还是估算、什么时候读的，过期的标出来', async () => {
    await upsertQuotaWindow(t.db, {
      poolId: 'relay-b',
      window: 'month_usd',
      used: 222,
      limit: 400,
      reading: 'estimated',
      readAt: ago(3 * HOUR).toISOString(),
    });
    const [relayB] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-b');
    expect(relayB?.windows[0]).toMatchObject({ reading: 'estimated', readAt: ago(3 * HOUR), state: 'stale' });
  });

  it('在跑的会话按账号池计：排队的、已结束的都不占名额，不属于任何需求的会话照样占', async () => {
    await addRoute(t.db, { id: 'a-opus', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'a-k3', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
    await addRoute(t.db, { id: 'b-opus', poolId: 'relay-b', modelId: 'opus-5.5' });
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await addRun(t.db, { taskId: task.id, routeId: 'a-opus', startedAt: ago(10 * MIN) });
    await addRun(t.db, { taskId: null, stage: 'research', routeId: 'a-k3', startedAt: ago(5 * MIN) }); // 帅位
    await addRun(t.db, { taskId: task.id, routeId: 'b-opus' }); // 还在排队
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'b-opus',
      queuedAt: ago(30 * MIN),
      startedAt: ago(20 * MIN),
      endedAt: ago(MIN),
      outcome: 'stopped',
    });
    const counts = await inFlightByPool(t.db);
    expect(Object.fromEntries(counts)).toEqual({ 'relay-a': 2 });
    const table = await quotaTable(t.db, { now: NOW });
    expect(table.map((p) => [p.poolId, p.inFlight, p.maxConcurrency])).toEqual([
      ['relay-a', 2, 2],
      ['relay-b', 0, 1],
    ]);
  });

  it('超额是真实情况：利用率可以大于 1，算用满，剩余按 0 显示', async () => {
    await upsertQuotaWindow(t.db, {
      poolId: 'relay-a',
      window: '5h',
      utilization: 1.25,
      reading: 'measured',
      readAt: ago(MIN).toISOString(),
    });
    const [relayA] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-a');
    expect(relayA?.windows[0]).toMatchObject({ utilization: 1.25, remainingRatio: 0, state: 'exhausted' });
  });

  it('订阅到期日一起给出', async () => {
    await t.db
      .update(pools)
      .set({ expiresAt: later(3 * 24 * HOUR) })
      .where(eq(pools.id, 'relay-a'));
    const [relayA] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-a');
    expect(relayA?.expiresAt).toEqual(later(3 * 24 * HOUR));
  });
});
