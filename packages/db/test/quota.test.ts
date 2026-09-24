import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  inFlightByPool,
  type PoolQuotaSnapshot,
  quotaTable,
  savePoolQuota,
  upsertQuotaWindow,
  windowState,
} from '../src/queries/quota.ts';
import { pools, quotaWindows } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addTask,
  ago,
  catalog,
  DAY,
  expectViolation,
  HOUR,
  later,
  MIN,
  NOW,
} from './helpers.ts';

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

  /** 中转 relay-a 上的实读。 */
  const relay = { poolId: 'relay-a', reading: 'measured', source: 'mirasim-relay' } as const;

  it('每个窗口各存一行：5h 快清零且几乎没用，调度看得到（不只存最紧的 7d）', async () => {
    await upsertQuotaWindow(t.db, {
      ...relay,
      label: '5h',
      window: '5h',
      used: 1140,
      limit: 143528,
      unit: 'points',
      resetsAt: later(2 * HOUR).toISOString(),
      readAt: ago(MIN).toISOString(),
    });
    await upsertQuotaWindow(t.db, {
      ...relay,
      label: '7d',
      window: '7d',
      used: 285511,
      limit: 512600,
      unit: 'points',
      resetsAt: later(4 * DAY).toISOString(),
      readAt: ago(MIN).toISOString(),
    });
    const [relayA] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-a');
    expect(relayA?.windows.map((w) => w.window)).toEqual(['5h', '7d']);
    expect(relayA?.windows[0]?.remainingRatio).toBeCloseTo(0.992, 3);
    expect(relayA?.windows[0]?.resetsInMs).toBe(2 * HOUR);
  });

  it('上限每次都按最新读数算', async () => {
    const base = { ...relay, label: '5h', window: '5h', unit: 'points', used: 1000 } as const;
    await upsertQuotaWindow(t.db, { ...base, limit: 171852, readAt: ago(20 * MIN).toISOString() });
    await upsertQuotaWindow(t.db, { ...base, limit: 143528, readAt: ago(MIN).toISOString() });
    const rows = await t.db.select().from(quotaWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.limit).toBe(143528);
  });

  it('读很多次，行数不涨', async () => {
    for (let i = 0; i < 50; i++) {
      await upsertQuotaWindow(t.db, {
        ...relay,
        label: '7d',
        window: '7d',
        utilization: i / 100,
        unit: 'percent',
        readAt: ago((50 - i) * MIN).toISOString(),
      });
    }
    const rows = await t.db.select().from(quotaWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.utilization).toBe(0.49);
  });

  it('晚到的旧读数不覆盖新的', async () => {
    const base = { ...relay, label: '7d', window: '7d', unit: 'percent' } as const;
    expect(await upsertQuotaWindow(t.db, { ...base, utilization: 0.6, readAt: ago(MIN).toISOString() })).toBe(
      true,
    );
    expect(
      await upsertQuotaWindow(t.db, { ...base, utilization: 0.2, readAt: ago(HOUR).toISOString() }),
    ).toBe(false);
    const [row] = await t.db.select().from(quotaWindows);
    expect(row?.utilization).toBe(0.6);
  });

  it('按上游原名分行存：账号级、几个模型组窗口、归不了类的 other 各一行，同名的覆盖', async () => {
    const at = ago(2 * MIN).toISOString();
    for (const w of [
      { label: '7d', window: '7d', utilization: 0.5 },
      { label: '7d_claude', window: '7d_model', scope: 'claude', utilization: 0.9 },
      {
        label: '7d_fable',
        window: '7d_model',
        scope: 'fable',
        upstreamStatus: 'limit_reached',
        statusRaw: 'rejected',
      },
      { label: 'weekly_all', window: 'other', utilization: 0.3 },
    ] as const) {
      await upsertQuotaWindow(t.db, { ...relay, unit: 'percent', readAt: at, ...w });
    }
    await upsertQuotaWindow(t.db, {
      ...relay,
      label: 'weekly_all',
      window: 'other',
      utilization: 0.35,
      unit: 'percent',
      readAt: ago(MIN).toISOString(),
    });
    const [relayA] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-a');
    expect(relayA?.windows.map((w) => [w.label, w.window, w.scope, w.utilization, w.state])).toEqual([
      ['7d', '7d', null, 0.5, 'ok'],
      ['7d_claude', '7d_model', 'claude', 0.9, 'ok'],
      ['7d_fable', '7d_model', 'fable', null, 'exhausted'],
      ['weekly_all', 'other', null, 0.35, 'ok'],
    ]);
    expect(relayA?.windows[2]?.statusRaw).toBe('rejected');
  });

  it('从没读到过额度的池也列出来，标「没查成」而不是「没有」', async () => {
    const table = await quotaTable(t.db, { now: NOW });
    expect(table.map((p) => [p.poolId, p.neverRead])).toEqual([
      ['relay-a', true],
      ['relay-b', true],
    ]);
  });

  it('每行写明实读还是估算、读法、单位、什么时候读的，过期的标出来', async () => {
    await upsertQuotaWindow(t.db, {
      poolId: 'relay-b',
      label: 'month_usd',
      window: 'month_usd',
      used: 222,
      limit: 400,
      unit: 'usd',
      reading: 'estimated',
      source: 'estimate',
      readAt: ago(3 * HOUR).toISOString(),
    });
    const [relayB] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-b');
    expect(relayB?.windows[0]).toMatchObject({
      reading: 'estimated',
      source: 'estimate',
      unit: 'usd',
      readAt: ago(3 * HOUR),
      state: 'stale',
    });
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
      ...relay,
      label: '5h',
      window: '5h',
      utilization: 1.25,
      unit: 'percent',
      readAt: ago(MIN).toISOString(),
    });
    const [relayA] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-a');
    expect(relayA?.windows[0]).toMatchObject({ utilization: 1.25, remainingRatio: 0, state: 'exhausted' });
  });

  it('订阅到期日一起给出', async () => {
    await t.db
      .update(pools)
      .set({ expiresAt: later(3 * DAY) })
      .where(eq(pools.id, 'relay-a'));
    const [relayA] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'relay-a');
    expect(relayA?.expiresAt).toEqual(later(3 * DAY));
  });

  describe('savePoolQuota：一个池一次读数整批写', () => {
    beforeEach(async () => {
      await t.db.insert(pools).values({ id: 'cursor-a', channelId: 'cursor', maxConcurrency: 2 });
    });

    const members = { auto: { in: ['composer-2'] }, api: { notIn: ['composer-2'] } };

    /** Cursor 的一次读数，形状照 adapters 额度读取器的输出：账期美元 + auto / api 两个桶，带账期末和成员表。 */
    function cursorRead(at: Date): PoolQuotaSnapshot {
      const base = {
        poolId: 'cursor-a',
        reading: 'measured',
        source: 'cursor-dashboard',
        resetsAt: later(20 * DAY).toISOString(),
        readAt: at.toISOString(),
      } as const;
      return {
        poolId: 'cursor-a',
        readAt: at.toISOString(),
        expiresAt: later(20 * DAY).toISOString(),
        scopeModels: members,
        windows: [
          { ...base, label: 'plan_usd', window: 'month_usd', used: 12.5, limit: 20, unit: 'usd' },
          {
            ...base,
            label: 'auto_percent',
            window: 'other',
            scope: 'auto',
            used: 40,
            limit: 100,
            unit: 'percent',
          },
          {
            ...base,
            label: 'api_percent',
            window: 'other',
            scope: 'api',
            used: 7,
            limit: 100,
            unit: 'percent',
          },
        ],
      };
    }

    const cursorPool = async () => {
      const [pool] = await t.db.select().from(pools).where(eq(pools.id, 'cursor-a'));
      return pool;
    };

    it('窗口、订阅到期日、成员表一起写进去', async () => {
      expect(await savePoolQuota(t.db, cursorRead(ago(MIN)))).toEqual({ written: 3, skippedAsOlder: 0 });
      const [cursor] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'cursor-a');
      expect(cursor?.expiresAt).toEqual(later(20 * DAY));
      expect(cursor?.scopeModels).toEqual(members);
      expect(cursor?.neverRead).toBe(false);
      // 同一时刻清零的按原名排。
      expect(cursor?.windows.map((w) => [w.label, w.window, w.scope, w.unit, w.source, w.state])).toEqual([
        ['api_percent', 'other', 'api', 'percent', 'cursor-dashboard', 'ok'],
        ['auto_percent', 'other', 'auto', 'percent', 'cursor-dashboard', 'ok'],
        ['plan_usd', 'month_usd', null, 'usd', 'cursor-dashboard', 'ok'],
      ]);
    });

    it('晚到的旧读数整批不生效：窗口不覆盖，到期日和成员表也不回退', async () => {
      await savePoolQuota(t.db, cursorRead(ago(MIN)));
      const older = { ...cursorRead(ago(HOUR)), expiresAt: later(DAY).toISOString(), scopeModels: {} };
      expect(await savePoolQuota(t.db, older)).toEqual({ written: 0, skippedAsOlder: 3 });
      const pool = await cursorPool();
      expect(pool?.expiresAt).toEqual(later(20 * DAY));
      expect(pool?.scopeModels).toEqual(members);
      const rows = await t.db.select().from(quotaWindows);
      expect(rows.map((r) => r.readAt)).toEqual([ago(MIN), ago(MIN), ago(MIN)]);
    });

    it('读数没带到期日和成员表，池上已有的不动（人填的到期日不被清掉）', async () => {
      await t.db
        .update(pools)
        .set({ expiresAt: later(9 * DAY), scopeModels: { auto: { in: ['composer-1'] } } })
        .where(eq(pools.id, 'cursor-a'));
      const { poolId, readAt, windows } = cursorRead(ago(MIN));
      expect(await savePoolQuota(t.db, { poolId, readAt, windows })).toEqual({
        written: 3,
        skippedAsOlder: 0,
      });
      const pool = await cursorPool();
      expect(pool?.expiresAt).toEqual(later(9 * DAY));
      expect(pool?.scopeModels).toEqual({ auto: { in: ['composer-1'] } });
    });

    it('这次没报的窗口不删：旧读数留着，按「没查成」显示', async () => {
      await savePoolQuota(t.db, cursorRead(ago(2 * HOUR)));
      const next = cursorRead(ago(MIN));
      await savePoolQuota(t.db, { ...next, windows: next.windows.filter((w) => w.label !== 'api_percent') });
      const [cursor] = (await quotaTable(t.db, { now: NOW })).filter((p) => p.poolId === 'cursor-a');
      expect(cursor?.windows.map((w) => [w.label, w.state])).toEqual([
        ['api_percent', 'stale'],
        ['auto_percent', 'ok'],
        ['plan_usd', 'ok'],
      ]);
    });

    it('写到一半被约束拒掉，整批回滚：窗口一个不留，到期日也不改', async () => {
      const read = cursorRead(ago(MIN));
      const [usd, auto] = read.windows;
      if (!usd || !auto) throw new Error('夹具少了窗口');
      const broken: PoolQuotaSnapshot = {
        ...read,
        // 7d_model 不写组名：前两个窗口已经写进去了，第三个被拒。
        windows: [usd, auto, { ...usd, label: '7d', window: '7d_model' }],
      };
      await expectViolation(savePoolQuota(t.db, broken), 'quota_windows_model_scope');
      expect(await t.db.select().from(quotaWindows)).toEqual([]);
      expect((await cursorPool())?.expiresAt).toBeNull();
    });

    it('读数对不上池、同一次读数里原名重复、池不存在：整批拒掉，一行不写', async () => {
      const read = cursorRead(ago(MIN));
      const [usd, auto] = read.windows;
      if (!usd || !auto) throw new Error('夹具少了窗口');
      await expect(
        savePoolQuota(t.db, { ...read, windows: [usd, { ...auto, poolId: 'relay-a' }] }),
      ).rejects.toThrow(/relay-a/);
      await expect(
        savePoolQuota(t.db, { ...read, windows: [usd, { ...auto, label: 'plan_usd' }] }),
      ).rejects.toThrow(/plan_usd/);
      await expect(
        savePoolQuota(t.db, {
          ...read,
          poolId: 'nowhere',
          windows: read.windows.map((w) => ({ ...w, poolId: 'nowhere' })),
        }),
      ).rejects.toThrow(/nowhere/);
      expect(await t.db.select().from(quotaWindows)).toEqual([]);
      expect((await cursorPool())?.expiresAt).toBeNull();
    });
  });
});
