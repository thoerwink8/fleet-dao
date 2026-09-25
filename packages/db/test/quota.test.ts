import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  inFlightByPool,
  type PoolQuotaSnapshot,
  QUOTA_UNREPORTED_TTL_MS,
  quotaTable,
  type StoredQuotaWindow,
  savePoolQuota,
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

/** 一个窗口的读数：没写的单位按百分比、读法按中转、实读；读数时刻由 readOk 填。 */
type WindowInput = Omit<StoredQuotaWindow, 'poolId' | 'readAt' | 'reading' | 'source' | 'unit'> &
  Partial<Pick<StoredQuotaWindow, 'reading' | 'source' | 'unit'>>;

/** 一个池在 at 这一刻的一次读成（读取器的 PoolReadOk 入库时就是这个形状）；没说的都当读全了。 */
function readOk(
  poolId: string,
  at: Date,
  windows: readonly WindowInput[],
  extra: Partial<Pick<PoolQuotaSnapshot, 'expiresAt' | 'scopeModels' | 'complete'>> = {},
): PoolQuotaSnapshot {
  const readAt = at.toISOString();
  return {
    poolId,
    readAt,
    complete: true,
    windows: windows.map(
      (w): StoredQuotaWindow => ({
        poolId,
        readAt,
        reading: 'measured',
        source: 'mirasim-relay',
        unit: 'percent',
        ...w,
      }),
    ),
    ...extra,
  };
}

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

  /** 写入口，时钟用测试的 NOW（读数时刻比它还晚的会按它算）。 */
  const save = (snapshot: PoolQuotaSnapshot, now = NOW) => savePoolQuota(t.db, snapshot, { now });
  const poolRow = async (id: string) => {
    const [pool] = await t.db.select().from(pools).where(eq(pools.id, id));
    return pool;
  };
  const tableRow = async (id: string) => (await quotaTable(t.db, { now: NOW })).find((p) => p.poolId === id);

  it('每个窗口各存一行：5h 快清零且几乎没用，调度看得到（不只存最紧的 7d）', async () => {
    await save(
      readOk('relay-a', ago(MIN), [
        {
          label: '5h',
          window: '5h',
          used: 1140,
          limit: 143528,
          unit: 'points',
          resetsAt: later(2 * HOUR).toISOString(),
        },
        {
          label: '7d',
          window: '7d',
          used: 285511,
          limit: 512600,
          unit: 'points',
          resetsAt: later(4 * DAY).toISOString(),
        },
      ]),
    );
    const relayA = await tableRow('relay-a');
    expect(relayA?.windows.map((w) => w.window)).toEqual(['5h', '7d']);
    expect(relayA?.windows[0]?.remainingRatio).toBeCloseTo(0.992, 3);
    expect(relayA?.windows[0]?.resetsInMs).toBe(2 * HOUR);
  });

  it('上限每次都按最新读数算', async () => {
    const fiveHour = { label: '5h', window: '5h', unit: 'points', used: 1000 } as const;
    await save(readOk('relay-a', ago(20 * MIN), [{ ...fiveHour, limit: 171852 }]));
    await save(readOk('relay-a', ago(MIN), [{ ...fiveHour, limit: 143528 }]));
    const rows = await t.db.select().from(quotaWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.limit).toBe(143528);
  });

  it('读很多次，行数不涨', async () => {
    for (let i = 0; i < 12; i++) {
      await save(
        readOk('relay-a', ago((12 - i) * MIN), [{ label: '7d', window: '7d', utilization: i / 100 }]),
      );
    }
    const rows = await t.db.select().from(quotaWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.utilization).toBe(0.11);
  });

  it('晚到的旧读数整批不生效：窗口不覆盖，最近读成时刻不倒退，也不标过期', async () => {
    const sevenDay = { label: '7d', window: '7d' } as const;
    await save(readOk('relay-a', ago(MIN), [{ ...sevenDay, utilization: 0.6 }]));
    expect(
      await save(
        readOk('relay-a', ago(HOUR), [
          { ...sevenDay, utilization: 0.2 },
          { label: '5h', window: '5h', utilization: 0.1 },
        ]),
      ),
    ).toEqual({ written: 0, skippedAsOlder: 2, markedStale: 0, deleted: 0 });
    const rows = await t.db.select().from(quotaWindows);
    expect(rows.map((r) => [r.label, r.utilization, r.staleSince])).toEqual([['7d', 0.6, null]]);
    expect((await poolRow('relay-a'))?.lastReadOkAt).toEqual(ago(MIN));
  });

  it('按上游原名分行存：账号级、几个模型组窗口、归不了类的 other 各一行，同名的覆盖', async () => {
    const windows = [
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
    ] as const;
    await save(readOk('relay-a', ago(2 * MIN), windows));
    await save(readOk('relay-a', ago(MIN), [...windows.slice(0, 3), { ...windows[3], utilization: 0.35 }]));
    const relayA = await tableRow('relay-a');
    expect(relayA?.windows.map((w) => [w.label, w.window, w.scope, w.utilization, w.state])).toEqual([
      ['7d', '7d', null, 0.5, 'ok'],
      ['7d_claude', '7d_model', 'claude', 0.9, 'ok'],
      ['7d_fable', '7d_model', 'fable', null, 'exhausted'],
      ['weekly_all', 'other', null, 0.35, 'ok'],
    ]);
    expect(relayA?.windows[2]?.statusRaw).toBe('rejected');
  });

  it('从没读成过的池也列出来，标「没查成」而不是「没有」', async () => {
    const table = await quotaTable(t.db, { now: NOW });
    expect(table.map((p) => [p.poolId, p.neverRead, p.readOverdue, p.lastReadOkAt])).toEqual([
      ['relay-a', true, true, null],
      ['relay-b', true, true, null],
    ]);
  });

  it('每行写明实读还是估算、读法、单位、什么时候读的；最近一次读成超过 30 分钟，池和窗口都标出来', async () => {
    await save(
      readOk('relay-b', ago(3 * HOUR), [
        {
          label: 'month_usd',
          window: 'month_usd',
          used: 222,
          limit: 400,
          unit: 'usd',
          reading: 'estimated',
          source: 'estimate',
        },
      ]),
    );
    const relayB = await tableRow('relay-b');
    expect(relayB?.windows[0]).toMatchObject({
      reading: 'estimated',
      source: 'estimate',
      unit: 'usd',
      readAt: ago(3 * HOUR),
      staleSince: null,
      state: 'stale',
    });
    expect([relayB?.neverRead, relayB?.readOverdue, relayB?.lastReadOkAt]).toEqual([
      false,
      true,
      ago(3 * HOUR),
    ]);
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
    await save(readOk('relay-a', ago(MIN), [{ label: '5h', window: '5h', utilization: 1.25 }]));
    const relayA = await tableRow('relay-a');
    expect(relayA?.windows[0]).toMatchObject({ utilization: 1.25, remainingRatio: 0, state: 'exhausted' });
  });

  it('订阅到期日一起给出', async () => {
    await t.db
      .update(pools)
      .set({ expiresAt: later(3 * DAY) })
      .where(eq(pools.id, 'relay-a'));
    expect((await tableRow('relay-a'))?.expiresAt).toEqual(later(3 * DAY));
  });

  describe('上游这次没报的窗口', () => {
    const threeWindows = [
      { label: '5h', window: '5h', utilization: 0.1 },
      { label: '7d', window: '7d', utilization: 0.2 },
      { label: '7d_claude', window: '7d_model', scope: 'claude', utilization: 0.3 },
    ] as const;
    const withoutClaude = threeWindows.slice(0, 2);

    it('标过期：照样列出、带过期时刻；已经标过的不重标', async () => {
      await save(readOk('relay-a', ago(2 * HOUR), threeWindows));
      expect(await save(readOk('relay-a', ago(HOUR), withoutClaude))).toEqual({
        written: 2,
        skippedAsOlder: 0,
        markedStale: 1,
        deleted: 0,
      });
      expect(await save(readOk('relay-a', ago(MIN), withoutClaude))).toEqual({
        written: 2,
        skippedAsOlder: 0,
        markedStale: 0,
        deleted: 0,
      });
      const relayA = await tableRow('relay-a');
      expect(relayA?.windows.map((w) => [w.label, w.staleSince, w.readAt])).toEqual([
        ['5h', null, ago(MIN)],
        ['7d', null, ago(MIN)],
        ['7d_claude', ago(HOUR), ago(2 * HOUR)],
      ]);
    });

    it('重新报了就恢复：过期标记清掉，读数换成新的', async () => {
      await save(readOk('relay-a', ago(2 * HOUR), threeWindows));
      await save(readOk('relay-a', ago(HOUR), withoutClaude));
      await save(readOk('relay-a', ago(MIN), [...withoutClaude, { ...threeWindows[2], utilization: 0.4 }]));
      const claude = (await tableRow('relay-a'))?.windows.find((w) => w.label === '7d_claude');
      expect([claude?.staleSince, claude?.readAt, claude?.utilization]).toEqual([null, ago(MIN), 0.4]);
    });

    it('标过期满 24 小时的删掉，差一点的不删', async () => {
      const markedAt = ago(QUOTA_UNREPORTED_TTL_MS + 2 * HOUR);
      await save(readOk('relay-a', ago(QUOTA_UNREPORTED_TTL_MS + 3 * HOUR), threeWindows));
      await save(readOk('relay-a', markedAt, withoutClaude));
      const justBefore = new Date(markedAt.getTime() + QUOTA_UNREPORTED_TTL_MS - 1);
      expect((await save(readOk('relay-a', justBefore, withoutClaude))).deleted).toBe(0);
      const atTtl = new Date(markedAt.getTime() + QUOTA_UNREPORTED_TTL_MS);
      expect((await save(readOk('relay-a', atTtl, withoutClaude))).deleted).toBe(1);
      const rows = await t.db.select().from(quotaWindows);
      expect(rows.map((r) => r.label).sort()).toEqual(['5h', '7d']);
    });

    it('读成但上游一个窗口都没报：池照样记读成，已有的窗口全部标过期', async () => {
      await save(readOk('relay-a', ago(HOUR), threeWindows));
      expect(await save(readOk('relay-a', ago(MIN), []))).toEqual({
        written: 0,
        skippedAsOlder: 0,
        markedStale: 3,
        deleted: 0,
      });
      const relayA = await tableRow('relay-a');
      expect([relayA?.neverRead, relayA?.readOverdue, relayA?.lastReadOkAt]).toEqual([
        false,
        false,
        ago(MIN),
      ]);
      expect(relayA?.windows.map((w) => w.staleSince)).toEqual([ago(MIN), ago(MIN), ago(MIN)]);
    });

    it('读失败时什么都不动：窗口不标过期也不删、最近读成时刻不更新，对账按池报超时；读成一次才补上', async () => {
      // 最后一次读成在两天前，那时 7d_claude 已经没报了；之后一直读失败（读失败不调写入口）。
      await save(readOk('relay-a', ago(2 * DAY + HOUR), threeWindows));
      await save(readOk('relay-a', ago(2 * DAY), withoutClaude));
      const before = await t.db.select().from(quotaWindows);

      const relayA = await tableRow('relay-a');
      expect([relayA?.readOverdue, relayA?.lastReadOkAt]).toEqual([true, ago(2 * DAY)]);
      // 过期满 24 小时的 7d_claude 也还在：删只在读成时顺带做。
      expect(await t.db.select().from(quotaWindows)).toEqual(before);

      expect(await save(readOk('relay-a', ago(MIN), withoutClaude))).toMatchObject({
        markedStale: 0,
        deleted: 1,
      });
      expect((await tableRow('relay-a'))?.readOverdue).toBe(false);
    });

    it('没读全（被动读数、读取器缺数丢过窗口）：只写收到的窗口，不标别的过期、不删，也不算一次读成', async () => {
      await save(readOk('relay-a', ago(2 * HOUR), threeWindows));
      const partial = readOk('relay-a', ago(MIN), [{ ...threeWindows[0], utilization: 0.5 }], {
        complete: false,
      });
      expect(await save(partial)).toEqual({ written: 1, skippedAsOlder: 0, markedStale: 0, deleted: 0 });
      const relayA = await tableRow('relay-a');
      expect(relayA?.windows.map((w) => [w.label, w.utilization, w.staleSince])).toEqual([
        ['5h', 0.5, null],
        ['7d', 0.2, null],
        ['7d_claude', 0.3, null],
      ]);
      // 最近读成时刻还是两小时前那次完整读：对账照样报超时。
      expect([relayA?.lastReadOkAt, relayA?.readOverdue]).toEqual([ago(2 * HOUR), true]);
    });
  });

  describe('读数的时刻', () => {
    const sevenDay = { label: '7d', window: '7d', utilization: 0.1 } as const;

    it('比现在还晚的按现在算：池不会被一次时钟跑快的读数冻住', async () => {
      await save(readOk('relay-a', later(HOUR), [sevenDay]));
      expect((await poolRow('relay-a'))?.lastReadOkAt).toEqual(NOW);
      expect((await t.db.select().from(quotaWindows)).map((r) => r.readAt)).toEqual([NOW]);
      // 五分钟后正常的一次读成照样写进去；没按现在算的话，它会被当成晚到的整批丢掉。
      const next = later(5 * MIN);
      expect(await save(readOk('relay-a', next, [{ ...sevenDay, utilization: 0.2 }]), next)).toMatchObject({
        written: 1,
      });
      expect((await poolRow('relay-a'))?.lastReadOkAt).toEqual(next);
    });

    it('上游数据本身冻住了（读是读成了，上游给的采集时刻不动）也报超时', async () => {
      // 中转的窗口读数时刻是上游自己的采集时刻：这次读在一分钟前，上游的数停在两小时前。
      const read = readOk('relay-a', ago(MIN), [sevenDay]);
      await save({
        ...read,
        windows: read.windows.map((w) => ({ ...w, readAt: ago(2 * HOUR).toISOString() })),
      });
      const relayA = await tableRow('relay-a');
      expect([relayA?.lastReadOkAt, relayA?.dataAt, relayA?.readOverdue]).toEqual([
        ago(MIN),
        ago(2 * HOUR),
        true,
      ]);
      await save(readOk('relay-a', NOW, [sevenDay]));
      expect((await tableRow('relay-a'))?.readOverdue).toBe(false);
    });

    it('读数时刻认不出：直接报错，一行不写', async () => {
      await expect(save({ ...readOk('relay-a', NOW, []), readAt: 'yesterday' })).rejects.toThrow(/yesterday/);
      const read = readOk('relay-a', NOW, [sevenDay]);
      await expect(
        save({ ...read, windows: read.windows.map((w) => ({ ...w, readAt: 'soon' })) }),
      ).rejects.toThrow(/soon/);
      expect(await t.db.select().from(quotaWindows)).toEqual([]);
      expect((await poolRow('relay-a'))?.lastReadOkAt).toBeNull();
    });
  });

  describe('savePoolQuota：一个池一次读数整批写', () => {
    beforeEach(async () => {
      await t.db.insert(pools).values({ id: 'cursor-a', channelId: 'cursor', maxConcurrency: 2 });
    });

    const members = { auto: { in: ['composer-2'] }, api: { notIn: ['composer-2'] } };

    /** Cursor 的一次读数，形状照 adapters 额度读取器的输出：账期美元 + auto / api 两个桶，带账期末和成员表。 */
    function cursorRead(at: Date): PoolQuotaSnapshot {
      const base = { source: 'cursor-dashboard', resetsAt: later(20 * DAY).toISOString() } as const;
      return readOk(
        'cursor-a',
        at,
        [
          { ...base, label: 'plan_usd', window: 'month_usd', used: 12.5, limit: 20, unit: 'usd' },
          { ...base, label: 'auto_percent', window: 'other', scope: 'auto', used: 40, limit: 100 },
          { ...base, label: 'api_percent', window: 'other', scope: 'api', used: 7, limit: 100 },
        ],
        { expiresAt: later(20 * DAY).toISOString(), scopeModels: members },
      );
    }

    it('窗口、订阅到期日、成员表、最近读成时刻一起写进去', async () => {
      expect(await save(cursorRead(ago(MIN)))).toEqual({
        written: 3,
        skippedAsOlder: 0,
        markedStale: 0,
        deleted: 0,
      });
      const cursor = await tableRow('cursor-a');
      expect(cursor?.expiresAt).toEqual(later(20 * DAY));
      expect(cursor?.scopeModels).toEqual(members);
      expect([cursor?.lastReadOkAt, cursor?.neverRead, cursor?.readOverdue]).toEqual([
        ago(MIN),
        false,
        false,
      ]);
      // 同一时刻清零的按原名排。
      expect(cursor?.windows.map((w) => [w.label, w.window, w.scope, w.unit, w.source, w.state])).toEqual([
        ['api_percent', 'other', 'api', 'percent', 'cursor-dashboard', 'ok'],
        ['auto_percent', 'other', 'auto', 'percent', 'cursor-dashboard', 'ok'],
        ['plan_usd', 'month_usd', null, 'usd', 'cursor-dashboard', 'ok'],
      ]);
    });

    it('晚到的旧读数不让到期日和成员表回退', async () => {
      await save(cursorRead(ago(MIN)));
      const older = { ...cursorRead(ago(HOUR)), expiresAt: later(DAY).toISOString(), scopeModels: {} };
      expect(await save(older)).toEqual({
        written: 0,
        skippedAsOlder: 3,
        markedStale: 0,
        deleted: 0,
      });
      const pool = await poolRow('cursor-a');
      expect([pool?.expiresAt, pool?.scopeModels, pool?.lastReadOkAt]).toEqual([
        later(20 * DAY),
        members,
        ago(MIN),
      ]);
      const rows = await t.db.select().from(quotaWindows);
      expect(rows.map((r) => r.readAt)).toEqual([ago(MIN), ago(MIN), ago(MIN)]);
    });

    it('读数没带到期日和成员表，池上已有的不动（人填的到期日不被清掉）', async () => {
      await t.db
        .update(pools)
        .set({ expiresAt: later(9 * DAY), scopeModels: { auto: { in: ['composer-1'] } } })
        .where(eq(pools.id, 'cursor-a'));
      const { poolId, readAt, windows } = cursorRead(ago(MIN));
      expect(await save({ poolId, readAt, complete: true, windows })).toMatchObject({ written: 3 });
      const pool = await poolRow('cursor-a');
      expect([pool?.expiresAt, pool?.scopeModels]).toEqual([
        later(9 * DAY),
        { auto: { in: ['composer-1'] } },
      ]);
    });

    it('写到一半被约束拒掉，整批回滚：窗口一个不留，到期日和最近读成时刻也不改', async () => {
      const read = cursorRead(ago(MIN));
      const [usd, auto] = read.windows;
      if (!usd || !auto) throw new Error('夹具少了窗口');
      const broken: PoolQuotaSnapshot = {
        ...read,
        // 7d_model 不写组名：前两个窗口已经写进去了，第三个被拒。
        windows: [usd, auto, { ...usd, label: '7d', window: '7d_model' }],
      };
      await expectViolation(save(broken), 'quota_windows_model_scope');
      expect(await t.db.select().from(quotaWindows)).toEqual([]);
      const pool = await poolRow('cursor-a');
      expect([pool?.expiresAt, pool?.lastReadOkAt]).toEqual([null, null]);
    });

    it('读数对不上池、同一次读数里原名重复、池不存在：整批拒掉，一行不写', async () => {
      const read = cursorRead(ago(MIN));
      const [usd, auto] = read.windows;
      if (!usd || !auto) throw new Error('夹具少了窗口');
      await expect(save({ ...read, windows: [usd, { ...auto, poolId: 'relay-a' }] })).rejects.toThrow(
        /relay-a/,
      );
      await expect(save({ ...read, windows: [usd, { ...auto, label: 'plan_usd' }] })).rejects.toThrow(
        /plan_usd/,
      );
      await expect(
        save({
          ...read,
          poolId: 'nowhere',
          windows: read.windows.map((w) => ({ ...w, poolId: 'nowhere' })),
        }),
      ).rejects.toThrow(/nowhere/);
      expect(await t.db.select().from(quotaWindows)).toEqual([]);
      const pool = await poolRow('cursor-a');
      expect([pool?.expiresAt, pool?.lastReadOkAt]).toEqual([null, null]);
    });
  });
});
