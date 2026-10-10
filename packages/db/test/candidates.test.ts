// 候选路由的判法（evaluateRoutes），经路由两层读（routing-layers.ts：选路、驾驶舱都走它）：每条路由为什么不能用、额度、并发。
// 两层怎么合成「活着吗」在 routing-layers.test.ts；选路怎么挑（死的跳过、不知道的排后面）在引擎的 store-ports.test.ts。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type StageKind, windowAppliesTo } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearReservations, reservePoolSlot } from '../src/queries/pool-runs.ts';
import { type PoolQuotaSnapshot, type StoredQuotaWindow, savePoolQuota } from '../src/queries/quota.ts';
import { finishRun, startRun } from '../src/queries/runs.ts';
import { flattenRoutingLayers, routingLayers } from '../src/routing-layers.ts';
import {
  bans,
  channels,
  models,
  poolReservations,
  pools,
  routes,
  routingCatalog,
  routingPurposeModels,
} from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addTask,
  addWindow,
  ago,
  catalog,
  DAY,
  HOUR,
  later,
  MIN,
  NOW,
  setRoutingLayers,
} from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
});

const fresh = { reading: 'measured', readAt: ago(MIN) } as const;
/** 这个用途摊平之后的候选：用途下模型的先后、再是模型下路由的先后。 */
const flat = async (purpose: StageKind, now = NOW) =>
  flattenRoutingLayers(await routingLayers(t.db, purpose, { now }));
const summary = async (purpose: StageKind) => (await flat(purpose)).map((c) => [c.routeId, c.blockers]);
/** 经写入口写一次读数，时钟用 NOW；没说的都当读全了。 */
const saveRead = (snapshot: Omit<PoolQuotaSnapshot, 'complete'> & { complete?: boolean }) =>
  savePoolQuota(t.db, { complete: true, ...snapshot }, { now: NOW });

describe('某个用途的候选路由', () => {
  it('按两层的顺序：先是用途下模型的先后，再是模型下路由的先后，不按 id 字母序', async () => {
    await addRoute(t.db, { id: 'z-first', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'a-second', poolId: 'relay-b', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'k3', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['kimi-k3', 'opus-5.5'] },
      models: { 'opus-5.5': ['z-first', 'a-second'], 'kimi-k3': ['k3'] },
    });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await addWindow(t.db, { poolId: 'relay-b', window: '7d', utilization: 0.1, ...fresh });
    expect(await summary('execute')).toEqual([
      ['k3', []],
      ['z-first', []],
      ['a-second', []],
    ]);
  });

  it('【故意造出的失败】用途没有模型、模型下一条路由都没有：候选为空并写明，不拿全部路由凑数', async () => {
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    const none = await routingLayers(t.db, 'research', { now: NOW });
    expect(flattenRoutingLayers(none)).toEqual([]);
    expect(none.problems).toEqual(['这个用途没有模型，派不了']);
    await setRoutingLayers(t.db, { purposes: { review: ['opus-5.5'] }, models: {} });
    const empty = await routingLayers(t.db, 'review', { now: NOW });
    expect(flattenRoutingLayers(empty)).toEqual([]);
    expect(empty.problems).toEqual(['模型 opus-5.5 没有路由（routing_catalog 里一条都没有）']);
  });

  it('被挡的路由不删，留在表里并写明每一条原因', async () => {
    await addRoute(t.db, { id: 'offline', poolId: 'relay-a', modelId: 'opus-5.5', alive: false });
    await addRoute(t.db, { id: 'retired', poolId: 'relay-a', modelId: 'opus-4.9' });
    await t.db
      .update(models)
      .set({ retiredAt: ago(HOUR) })
      .where(eq(models.id, 'opus-4.9'));
    await setRoutingLayers(t.db, {
      purposes: { execute: ['opus-5.5', 'opus-4.9'] },
      models: { 'opus-5.5': ['offline'], 'opus-4.9': ['retired'] },
    });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    expect(await summary('execute')).toEqual([
      ['offline', ['offline']],
      ['retired', ['model-retired']],
    ]);
  });

  it('按需探测（on_demand）的路由不出 offline 那条挡：alive 仍是 false，靠 probe_state 区分（#1635）', async () => {
    await addRoute(t.db, { id: 'hot', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'cold', poolId: 'relay-b', modelId: 'opus-5.5', alive: false });
    await addRoute(t.db, {
      id: 'dead',
      poolId: 'relay-b',
      modelId: 'opus-5.5',
      hostId: 'mirasim',
      alive: false,
    });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['opus-5.5'] },
      models: { 'opus-5.5': ['hot', 'cold', 'dead'] },
    });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await addWindow(t.db, { poolId: 'relay-b', window: '7d', utilization: 0.1, ...fresh });
    await t.db
      .update(routes)
      .set({
        probeState: 'on_demand',
        probedAt: ago(3 * HOUR),
        probeDetail: '不主动探，要派给它时先探一次。还没真探过',
      })
      .where(eq(routes.id, 'cold'));
    await t.db
      .update(routes)
      .set({ probeState: 'failed', probedAt: ago(HOUR), probeDetail: '没通' })
      .where(eq(routes.id, 'dead'));
    expect(await summary('execute')).toEqual([
      ['hot', []],
      ['cold', []],
      ['dead', ['offline']],
    ]);
    expect((await t.db.select().from(routes).where(eq(routes.id, 'cold')))[0]?.alive).toBe(false);
  });

  it('探针下结论的时刻原样给（在线的有，探针还没看过的为空）；过没过期由选路判，候选查询不因此挡', async () => {
    await addRoute(t.db, { id: 'probed', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'never', poolId: 'relay-b', modelId: 'opus-5.5', alive: false });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['opus-5.5'] },
      models: { 'opus-5.5': ['probed', 'never'] },
    });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await addWindow(t.db, { poolId: 'relay-b', window: '7d', utilization: 0.1, ...fresh });
    // 三小时前的结论（探针可能停了）：照样在线，挡不挡只看 alive
    await t.db
      .update(routes)
      .set({ probedAt: ago(3 * HOUR) })
      .where(eq(routes.id, 'probed'));
    const [probed, never] = await flat('execute');
    expect(probed).toMatchObject({ routeId: 'probed', probedAt: ago(3 * HOUR), blockers: [] });
    expect(never).toMatchObject({ routeId: 'never', probedAt: null, blockers: ['offline'] });
  });

  it('渠道关了、订阅过期都挡', async () => {
    await addRoute(t.db, { id: 'r-a', poolId: 'relay-a', modelId: 'opus-5.5' });
    await setRoutingLayers(t.db, { purposes: { execute: ['opus-5.5'] }, models: { 'opus-5.5': ['r-a'] } });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await t.db.update(channels).set({ enabled: false }).where(eq(channels.id, 'relay'));
    await t.db
      .update(pools)
      .set({ expiresAt: ago(MIN) })
      .where(eq(pools.id, 'relay-a'));
    expect(await summary('execute')).toEqual([['r-a', ['channel-disabled', 'pool-expired']]]);
  });

  it('禁令：代码里的硬禁令（GPT 不做 UI）库里没有也生效，再并上库里另加的；按用途判', async () => {
    expect(await t.db.select().from(bans)).toEqual([]);
    await addRoute(t.db, { id: 'gpt', poolId: 'relay-a', modelId: 'gpt-5.6-luna', hostId: 'codex' });
    await addRoute(t.db, { id: 'fable51', poolId: 'relay-a', modelId: 'fable-5.1' });
    await addRoute(t.db, { id: 'fable52', poolId: 'relay-b', modelId: 'claude-fable-5.2' });
    await addRoute(t.db, { id: 'grok', poolId: 'relay-b', modelId: 'grok-4.7', hostId: 'grok' });
    await setRoutingLayers(t.db, {
      purposes: {
        ui: ['gpt-5.6-luna', 'fable-5.1', 'claude-fable-5.2', 'grok-4.7'],
        execute: ['gpt-5.6-luna', 'grok-4.7'],
      },
      models: {
        'gpt-5.6-luna': ['gpt'],
        'fable-5.1': ['fable51'],
        'claude-fable-5.2': ['fable52'],
        'grok-4.7': ['grok'],
      },
    });
    await t.db.insert(bans).values({ family: 'grok', stage: 'ui', reason: '创始人另加：Grok 暂不做 UI' });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await addWindow(t.db, { poolId: 'relay-b', window: '7d', utilization: 0.1, ...fresh });
    // Fable 不再是硬禁令（决定 0033）：配进了用途、开关开着（创始人本人配的）就照常可选
    expect((await flat('ui')).map((c) => [c.routeId, c.blockers, c.banReasons])).toEqual([
      ['gpt', ['banned'], ['GPT 不做 UI 类活']],
      ['fable51', [], []],
      ['fable52', [], []],
      ['grok', ['banned'], ['创始人另加：Grok 暂不做 UI']],
    ]);
    expect(await summary('execute')).toEqual([
      ['gpt', []],
      ['grok', []],
    ]);
  });

  it('Fable 入库默认关着、不在任何用途里：不是候选；创始人开了并配进用途才可选，关回去又挡', async () => {
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await addRoute(t.db, { id: 'fable52', poolId: 'relay-a', modelId: 'claude-fable-5.2' });
    await addRoute(t.db, { id: 'lite52', poolId: 'relay-a', modelId: 'claude-lite-5.2' });
    // 路由表里有、关着；两个用途里都没有它
    await t.db.insert(routingCatalog).values([
      { modelId: 'claude-fable-5.2', routeId: 'fable52', position: 0, enabled: false },
      { modelId: 'claude-lite-5.2', routeId: 'lite52', position: 0, enabled: true },
    ]);
    await t.db
      .insert(routingPurposeModels)
      .values({ purpose: 'execute', modelId: 'claude-lite-5.2', position: 0 });
    expect((await flat('execute')).map((c) => c.routeId)).toEqual(['lite52']);
    // 配进用途但开关还关着：挡在开关上
    await t.db
      .insert(routingPurposeModels)
      .values({ purpose: 'execute', modelId: 'claude-fable-5.2', position: 1 });
    expect((await flat('execute')).map((c) => [c.routeId, c.blockers])).toEqual([
      ['lite52', []],
      ['fable52', ['switched-off']],
    ]);
    // 创始人打开
    await t.db.update(routingCatalog).set({ enabled: true }).where(eq(routingCatalog.routeId, 'fable52'));
    expect((await flat('execute')).map((c) => [c.routeId, c.blockers])).toEqual([
      ['lite52', []],
      ['fable52', []],
    ]);
  });

  it('模型组窗口只卡组名对得上的模型：7d_claude 满了，同池的 Kimi 照常', async () => {
    await addRoute(t.db, { id: 'opus', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'k3', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['opus-5.5', 'kimi-k3'] },
      models: { 'opus-5.5': ['opus'], 'kimi-k3': ['k3'] },
    });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', used: 285511, limit: 512600, ...fresh });
    await addWindow(t.db, {
      poolId: 'relay-a',
      window: '7d_model',
      scope: 'claude',
      used: 510000,
      limit: 512600,
      upstreamStatus: 'limit_reached',
      resetsAt: later(2 * 24 * HOUR),
      ...fresh,
    });
    expect((await flat('execute')).map((c) => [c.routeId, c.quota, c.windows.length, c.blockers])).toEqual([
      ['opus', 'exhausted', 2, ['quota-exhausted']],
      ['k3', 'ok', 1, []],
    ]);
  });

  it('模型组名按族名或模型 id 匹配，大小写和分隔符不计较', () => {
    const opus = { id: 'opus-5.5', family: 'claude' };
    // 库里账号级窗口的 scope 是空串。
    expect(windowAppliesTo({ scope: '' }, opus)).toBe('yes');
    expect(windowAppliesTo({ scope: 'claude' }, opus)).toBe('yes');
    expect(windowAppliesTo({ scope: 'fable' }, { id: 'claude-fable-5.2', family: 'claude' })).toBe('yes');
    expect(windowAppliesTo({ scope: 'fable' }, opus)).toBe('no');
    expect(windowAppliesTo({ scope: 'Opus_5_5' }, opus)).toBe('yes');
  });

  it('池给了成员表就只和路由在上游的名字比：in 只扣名单里的，notIn 扣名单外的；不知道上游名字就判不了', () => {
    const members = { auto: { in: ['Composer-2'] }, api: { notIn: ['composer_2'] } };
    const composer = { id: 'composer-2', family: 'cursor', upstreamNames: ['composer-2'] };
    const opus = { id: 'opus-5.5', family: 'claude', upstreamNames: ['claude-opus-5-5'] };
    expect(windowAppliesTo({ scope: 'auto' }, composer, members)).toBe('yes');
    expect(windowAppliesTo({ scope: 'auto' }, opus, members)).toBe('no');
    expect(windowAppliesTo({ scope: 'api' }, composer, members)).toBe('no');
    expect(windowAppliesTo({ scope: 'api' }, opus, members)).toBe('yes');
    // 成员表里没有的组照旧按组名。
    expect(windowAppliesTo({ scope: 'claude' }, opus, members)).toBe('yes');
    // 模型目录的 id 不算上游名字：没填上游名字的，两个桶都判不了，不默认落进「名单外都扣」的 api 桶。
    const bare = { id: 'composer-2', family: 'cursor' };
    expect(windowAppliesTo({ scope: 'auto' }, bare, members)).toBe('unknown');
    expect(windowAppliesTo({ scope: 'api' }, bare, members)).toBe('unknown');
    // 实际发的串和额度接口的叫法不同名时，靠别名对上。
    const cursorAuto = { id: 'cursor-auto', family: 'cursor', upstreamNames: ['auto', 'default'] };
    expect(windowAppliesTo({ scope: 'auto' }, cursorAuto, { auto: { in: ['default'] } })).toBe('yes');
    // 没有成员表时，auto / api 这种组名跟哪个模型名都对不上：成员表不入库，Cursor 的桶就卡不住任何路由。
    expect(windowAppliesTo({ scope: 'auto' }, composer)).toBe('no');
  });

  it('Cursor 的 auto / api 两个桶按读数带来的成员表卡：auto 满了只挡 Composer，api 满了只挡点名的其它模型', async () => {
    await t.db.insert(pools).values({ id: 'cursor-a', channelId: 'cursor', maxConcurrency: 2 });
    await t.db.insert(models).values({ id: 'composer-2', family: 'cursor', displayName: 'Composer 2' });
    const onCursor = { channelId: 'cursor', poolId: 'cursor-a', hostId: 'cursor-agent' } as const;
    await addRoute(t.db, { id: 'composer', modelId: 'composer-2', upstreamModel: 'composer-2', ...onCursor });
    await addRoute(t.db, {
      id: 'opus-on-cursor',
      modelId: 'opus-5.5',
      upstreamModel: 'claude-opus-5-5',
      ...onCursor,
    });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['composer-2', 'opus-5.5'] },
      models: { 'composer-2': ['composer'], 'opus-5.5': ['opus-on-cursor'] },
    });
    // 读取器的原样输出：两个桶都归 other，组名 auto / api，成员表来自接口的 autoBucketModels。
    const read = (used: { auto: number; api: number }, at: Date) =>
      saveRead({
        poolId: 'cursor-a',
        readAt: at.toISOString(),
        scopeModels: { auto: { in: ['composer-2'] }, api: { notIn: ['composer-2'] } },
        windows: (['auto', 'api'] as const).map(
          (scope): StoredQuotaWindow => ({
            poolId: 'cursor-a',
            label: `${scope}_percent`,
            window: 'other',
            scope,
            used: used[scope],
            limit: 100,
            unit: 'percent',
            reading: 'measured',
            source: 'cursor-dashboard',
            readAt: at.toISOString(),
          }),
        ),
      });
    await read({ auto: 100, api: 30 }, ago(2 * MIN));
    expect(await summary('execute')).toEqual([
      ['composer', ['quota-exhausted']],
      ['opus-on-cursor', []],
    ]);
    await read({ auto: 10, api: 100 }, ago(MIN));
    expect(await summary('execute')).toEqual([
      ['composer', []],
      ['opus-on-cursor', ['quota-exhausted']],
    ]);
  });

  it('上游这次没报的窗口不挡路由、不让路由排后；最后一次读到是用满、还没到清零时刻的照样挡', async () => {
    await addRoute(t.db, { id: 'opus-b', poolId: 'relay-b', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'k3-a', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
    await addRoute(t.db, { id: 'opus-a', poolId: 'relay-a', modelId: 'opus-5.5' });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['opus-5.5', 'kimi-k3'] },
      models: { 'opus-5.5': ['opus-b', 'opus-a'], 'kimi-k3': ['k3-a'] },
    });
    const base = (poolId: string, at: Date) =>
      ({
        poolId,
        unit: 'percent',
        reading: 'measured',
        source: 'mirasim-relay',
        readAt: at.toISOString(),
      }) as const;
    const sevenDay = (poolId: string, at: Date): StoredQuotaWindow => ({
      ...base(poolId, at),
      label: '7d',
      window: '7d',
      utilization: 0.1,
    });
    const claudeFull = (poolId: string, at: Date): StoredQuotaWindow => ({
      ...base(poolId, at),
      label: '7d_claude',
      window: '7d_model',
      scope: 'claude',
      upstreamStatus: 'limit_reached',
    });
    const save = (poolId: string, at: Date, windows: StoredQuotaWindow[]) =>
      saveRead({ poolId, readAt: at.toISOString(), windows });
    // 两小时前那次读成都报了 7d_claude 用满：relay-a 给了明天的清零时刻，relay-b 没给。刚才这次读成都没再报它。
    const before = ago(2 * HOUR);
    await save('relay-a', before, [
      sevenDay('relay-a', before),
      { ...claudeFull('relay-a', before), resetsAt: later(DAY).toISOString() },
    ]);
    await save('relay-b', before, [sevenDay('relay-b', before), claudeFull('relay-b', before)]);
    await save('relay-a', ago(MIN), [sevenDay('relay-a', ago(MIN))]);
    await save('relay-b', ago(MIN), [sevenDay('relay-b', ago(MIN))]);
    // relay-b 的旧「满」不知道哪天清零、读数也旧了：不挡，额度照算 ok（不让 opus-b 当成额度未知排到后面）。
    // relay-a 的明天才清零：照样挡 opus-a。
    expect(
      (await flat('execute')).map((c) => [c.routeId, c.quota, c.blockers, c.windows.map((w) => w.label)]),
    ).toEqual([
      ['opus-b', 'ok', [], ['7d']],
      ['opus-a', 'exhausted', ['quota-exhausted'], ['7d', '7d_claude']],
      ['k3-a', 'ok', [], ['7d']],
    ]);
  });

  it('中转 7d_claude 已满、明天才清零，之后的读数里没了它：Opus 照样挡，过了清零时刻才放', async () => {
    await addRoute(t.db, { id: 'opus', poolId: 'relay-a', modelId: 'opus-5.5' });
    await setRoutingLayers(t.db, { purposes: { execute: ['opus-5.5'] }, models: { 'opus-5.5': ['opus'] } });
    const tomorrow = later(DAY);
    const relayWindow = (label: string, at: Date, more: Partial<StoredQuotaWindow>): StoredQuotaWindow => ({
      poolId: 'relay-a',
      label,
      window: '7d',
      unit: 'points',
      reading: 'measured',
      source: 'mirasim-relay',
      readAt: at.toISOString(),
      ...more,
    });
    const sevenDay = (at: Date) => relayWindow('7d', at, { used: 1, limit: 100 });
    const claudeFull = (at: Date) =>
      relayWindow('7d_claude', at, {
        window: '7d_model',
        scope: 'claude',
        upstreamStatus: 'limit_reached',
        resetsAt: tomorrow.toISOString(),
      });
    await saveRead({
      poolId: 'relay-a',
      readAt: ago(3 * MIN).toISOString(),
      windows: [sevenDay(ago(3 * MIN)), claudeFull(ago(3 * MIN))],
    });
    // 读取器缺数丢了它、自己说没读全：不标过期，照旧挡。
    await saveRead({
      poolId: 'relay-a',
      readAt: ago(2 * MIN).toISOString(),
      complete: false,
      windows: [sevenDay(ago(2 * MIN))],
    });
    const opusAt = async (now: Date) => (await flat('execute', now))[0];
    expect((await opusAt(NOW))?.blockers).toEqual(['quota-exhausted']);
    // 下一次说读全了、还是没有它：标了过期，最后一次读到是用满、明天才清零，照样挡。
    await saveRead({ poolId: 'relay-a', readAt: ago(MIN).toISOString(), windows: [sevenDay(ago(MIN))] });
    const blocked = await opusAt(NOW);
    expect([blocked?.blockers, blocked?.windows.map((w) => [w.label, w.staleSince])]).toEqual([
      ['quota-exhausted'],
      [
        ['7d', null],
        ['7d_claude', ago(MIN)],
      ],
    ]);
    // 过了清零时刻才放（那时读数也旧了，额度按未知算，但不挡）。
    const released = await opusAt(new Date(tomorrow.getTime() + MIN));
    expect([released?.blockers, released?.quota, released?.windows.map((w) => w.label)]).toEqual([
      [],
      'unknown',
      ['7d'],
    ]);
  });

  it('真夹具：Cursor 的 Auto 桶名单（default、composer-2……）配种子里的 cursor-auto', async () => {
    // 额度读取器测试用的 Cursor 真回包（2026-09-24 实读）；读取器从 autoBucketModels 生成成员表。
    const fixture = JSON.parse(
      readFileSync(
        new URL('../../adapters/test/quota/fixtures/cursor-period-usage-2026-09-24.json', import.meta.url),
        'utf8',
      ),
    ) as { autoBucketModels: string[] };
    const autoModels = fixture.autoBucketModels;
    expect(autoModels).toEqual(expect.arrayContaining(['default', 'composer-2']));
    expect(autoModels).not.toContain('cursor-auto');

    await t.db.insert(pools).values({ id: 'cursor-a', channelId: 'cursor', maxConcurrency: 3 });
    const onCursor = { channelId: 'cursor', poolId: 'cursor-a', hostId: 'cursor-agent' } as const;
    // Cursor Auto 在额度接口里叫 default；Grok 那条没填上游名字；Opus 那条是点名的其它模型。
    await addRoute(t.db, {
      id: 'cursor-auto',
      modelId: 'cursor-auto',
      upstreamAliases: ['default'],
      ...onCursor,
    });
    await addRoute(t.db, { id: 'grok-on-cursor', modelId: 'grok-4.7', ...onCursor });
    await addRoute(t.db, {
      id: 'opus-on-cursor',
      modelId: 'opus-5.5',
      upstreamModel: 'claude-opus-5-5',
      ...onCursor,
    });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['cursor-auto', 'grok-4.7', 'opus-5.5'] },
      models: {
        'cursor-auto': ['cursor-auto'],
        'grok-4.7': ['grok-on-cursor'],
        'opus-5.5': ['opus-on-cursor'],
      },
    });

    const at = ago(MIN).toISOString();
    const bucket = (scope: 'auto' | 'api', used: number): StoredQuotaWindow => ({
      poolId: 'cursor-a',
      label: `${scope}_percent`,
      window: 'other',
      scope,
      used,
      limit: 100,
      unit: 'percent',
      reading: 'measured',
      source: 'cursor-dashboard',
      readAt: at,
    });
    await saveRead({
      poolId: 'cursor-a',
      readAt: at,
      scopeModels: { auto: { in: autoModels }, api: { notIn: autoModels } },
      windows: [
        {
          poolId: 'cursor-a',
          label: 'plan_usd',
          window: 'month_usd',
          used: 222.81,
          limit: 400,
          unit: 'usd',
          reading: 'measured',
          source: 'cursor-dashboard',
          readAt: at,
        },
        bucket('auto', 100),
        bucket('api', 0),
      ],
    });
    expect(
      (await flat('execute')).map((c) => [
        c.routeId,
        c.quota,
        c.blockers,
        c.windows.map((w) => `${w.label}:${w.applies}`).sort(),
      ]),
    ).toEqual([
      ['cursor-auto', 'exhausted', ['quota-exhausted'], ['auto_percent:yes', 'plan_usd:yes']],
      // 不知道 Grok 这条在 Cursor 叫什么：两个桶都判不了，额度按未知算（不挡；排不排后面由选路判），不算进 api 桶。
      ['grok-on-cursor', 'unknown', [], ['api_percent:unknown', 'auto_percent:unknown', 'plan_usd:yes']],
      ['opus-on-cursor', 'ok', [], ['api_percent:yes', 'plan_usd:yes']],
    ]);
  });

  it('读成了、只是没有扣这个模型的窗口：算 ok，不当没读成', async () => {
    await t.db.insert(pools).values({ id: 'cursor-a', channelId: 'cursor', maxConcurrency: 1 });
    await addRoute(t.db, { id: 'never-read', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, {
      id: 'opus-on-cursor',
      channelId: 'cursor',
      poolId: 'cursor-a',
      modelId: 'opus-5.5',
      hostId: 'cursor-agent',
      upstreamModel: 'claude-opus-5-5',
    });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['opus-5.5'] },
      models: { 'opus-5.5': ['never-read', 'opus-on-cursor'] },
    });
    // Cursor 这次只报了 auto 桶（用满了），成员表说它只扣 Composer。
    await saveRead({
      poolId: 'cursor-a',
      readAt: ago(MIN).toISOString(),
      scopeModels: { auto: { in: ['composer-2'] } },
      windows: [
        {
          poolId: 'cursor-a',
          label: 'auto_percent',
          window: 'other',
          scope: 'auto',
          used: 100,
          limit: 100,
          unit: 'percent',
          reading: 'measured',
          source: 'cursor-dashboard',
          readAt: ago(MIN).toISOString(),
        },
      ],
    });
    expect((await flat('execute')).map((c) => [c.routeId, c.quota, c.blockers, c.windows.length])).toEqual([
      ['never-read', 'unknown', [], 0],
      ['opus-on-cursor', 'ok', [], 0],
    ]);
  });

  it('额度没读成（从没读过、读数过期）不挡、标 unknown，照两层的顺序给（排不排后面由选路判）', async () => {
    await t.db.insert(pools).values({ id: 'relay-c', channelId: 'relay', maxConcurrency: 1 });
    await addRoute(t.db, { id: 'never-read', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'stale', poolId: 'relay-b', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'fresh', poolId: 'relay-c', modelId: 'opus-5.5' });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['opus-5.5'] },
      models: { 'opus-5.5': ['never-read', 'stale', 'fresh'] },
    });
    await addWindow(t.db, {
      poolId: 'relay-b',
      window: '7d',
      utilization: 0.1,
      reading: 'measured',
      readAt: ago(3 * HOUR),
    });
    await addWindow(t.db, { poolId: 'relay-c', window: '7d', utilization: 0.1, ...fresh });
    expect((await flat('execute')).map((c) => [c.routeId, c.position, c.quota, c.eligible])).toEqual([
      ['never-read', 0, 'unknown', true],
      ['stale', 1, 'unknown', true],
      ['fresh', 2, 'ok', true],
    ]);
  });

  it('并发按账号池算：同渠道的另一个池满了不影响这个池；不属于任何需求的会话也占名额', async () => {
    await addRoute(t.db, { id: 'a', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'b', poolId: 'relay-b', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'b-k3', poolId: 'relay-b', modelId: 'kimi-k3', hostId: 'mirasim' });
    await setRoutingLayers(t.db, { purposes: { execute: ['opus-5.5'] }, models: { 'opus-5.5': ['a', 'b'] } });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await addWindow(t.db, { poolId: 'relay-b', window: '7d', utilization: 0.1, ...fresh });
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    // relay-b 上限 1：一场考新模型的会话（不属于任何需求、路由也不在本用途）占着。
    await addRun(t.db, { taskId: null, stage: 'judge', routeId: 'b-k3', startedAt: ago(5 * MIN) });
    // relay-a 上限 2：只有一个在跑，一个已结束。
    await addRun(t.db, { taskId: task.id, routeId: 'a', startedAt: ago(5 * MIN) });
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'a',
      queuedAt: ago(60 * MIN),
      startedAt: ago(50 * MIN),
      endedAt: ago(40 * MIN),
      outcome: 'ok',
    });
    expect((await flat('execute')).map((c) => [c.routeId, c.inFlight, c.maxConcurrency, c.blockers])).toEqual(
      [
        ['a', 1, 2, []],
        ['b', 1, 1, ['no-slot']],
      ],
    );
  });

  it('三段的一次性会话（runs 里开着的行，#157）也占名额：拼车池上限 3，两行三段 + 一行 Fusion 的会话就没空位；收了一行又有', async () => {
    await t.db.insert(pools).values({
      id: 'claude-carpool',
      channelId: 'claude-subscription',
      maxConcurrency: 3,
      runAsUser: 'fleet-agent-carpool',
      orgKind: 'carpool',
    });
    await addRoute(t.db, {
      id: 'car',
      channelId: 'claude-subscription',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      upstreamModel: 'claude-opus-5-5',
    });
    await addRoute(t.db, { id: 'a', poolId: 'relay-a', modelId: 'opus-5.5' });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['opus-5.5'] },
      models: { 'opus-5.5': ['car', 'a'] },
    });
    await addWindow(t.db, { poolId: 'claude-carpool', window: '5h', utilization: 0.1, ...fresh });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await addRun(t.db, { taskId: task.id, routeId: 'car', startedAt: ago(20 * MIN) });
    const manual = randomUUID();
    await startRun(t.db, {
      id: manual,
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'car',
      startedAt: ago(10 * MIN),
    });
    await startRun(t.db, { segment: 'verify', model: 'opus-5.5', routeId: 'car', startedAt: ago(5 * MIN) });
    const slots = async () =>
      (await flat('execute')).map((c) => [c.routeId, c.inFlight, c.maxConcurrency, c.blockers]);

    expect(await slots()).toEqual([
      ['car', 3, 3, ['no-slot']],
      ['a', 0, 2, []],
    ]);
    await finishRun(t.db, { runId: manual, outcome: 'done' }, NOW);
    expect(await slots()).toEqual([
      ['car', 2, 3, []],
      ['a', 0, 2, []],
    ]);
  });

  describe('已选定还没开跑的预占也占名额（#800）：候选查询的 no-slot 和引擎、驾驶舱同一个判法（shared 的 poolFull）', () => {
    const setup = async () => {
      await t.db.insert(pools).values({
        id: 'claude-carpool',
        channelId: 'claude-subscription',
        maxConcurrency: 3,
        runAsUser: 'fleet-agent-carpool',
        orgKind: 'carpool',
      });
      await addRoute(t.db, {
        id: 'car',
        channelId: 'claude-subscription',
        poolId: 'claude-carpool',
        modelId: 'opus-5.5',
        upstreamModel: 'claude-opus-5-5',
      });
      await setRoutingLayers(t.db, { purposes: { execute: ['opus-5.5'] }, models: { 'opus-5.5': ['car'] } });
      await addWindow(t.db, { poolId: 'claude-carpool', window: '5h', utilization: 0.1, ...fresh });
      const repo = await addRepo(t.db);
      const tasks: [{ id: string }, { id: string }, { id: string }] = [
        await addTask(t.db, repo.id),
        await addTask(t.db, repo.id),
        await addTask(t.db, repo.id),
      ];
      const reserve = async (taskId: string, over: { reservedAt?: Date; expiresAt?: Date } = {}) => {
        const got = await reservePoolSlot(t.db, {
          taskId,
          segment: 'manual',
          routeId: 'car',
          reservedAt: NOW,
          expiresAt: later(20 * MIN),
          ...over,
        });
        if (!got.reserved) throw new Error(`夹具：${taskId} 应该预占上了`);
      };
      const view = async () =>
        (await flat('execute')).map((c) => [c.inFlight, c.reserved, c.maxConcurrency, c.blockers]);
      return { tasks, reserve, view };
    };

    it('上限 3、1 个在跑、2 个预占：满了（no-slot），不是 1/3 没满', async () => {
      const { tasks, reserve, view } = await setup();
      const [a, b] = tasks;
      await addRun(t.db, { taskId: a.id, routeId: 'car', startedAt: ago(20 * MIN) });
      expect(await view()).toEqual([[1, 0, 3, []]]);
      await reserve(a.id);
      expect(await view()).toEqual([[1, 1, 3, []]]);
      await reserve(b.id);
      expect(await view()).toEqual([[1, 2, 3, ['no-slot']]]);
    });

    it('预占过了期不算占用；引擎重启清掉预占（clearReservations）之后不再算，又有空位', async () => {
      const { tasks, reserve, view } = await setup();
      const [a, b, c] = tasks;
      await addRun(t.db, { taskId: a.id, routeId: 'car', startedAt: ago(20 * MIN) });
      await reserve(b.id);
      await reserve(c.id);
      expect(await view()).toEqual([[1, 2, 3, ['no-slot']]]);
      // 过期的那一张：直接把它的过期时刻挪到现在以前（预占那一步会顺手收掉过期的，这里要它留在表里）
      await t.db
        .update(poolReservations)
        .set({ reservedAt: ago(40 * MIN), expiresAt: ago(20 * MIN) })
        .where(eq(poolReservations.taskId, c.id));
      expect(await view()).toEqual([[1, 1, 3, []]]);
      await clearReservations(t.db);
      expect(await view()).toEqual([[1, 0, 3, []]]);
    });
  });
});
