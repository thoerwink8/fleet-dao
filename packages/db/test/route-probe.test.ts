// 路由探针的读写（#129）：读出每条路由探得了探不了的事实；写结论时只有 ok 让它在线、写不进去的明确报错。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toRoute } from '../src/domain-map.ts';
import { routeProbeTargets, saveRouteProbe } from '../src/queries/probe.ts';
import { channels, models, pools, routes, stagePolicyRoutes } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRoute, catalog, MIN, NOW, setStageOrder } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await t.db.insert(pools).values([
    {
      id: 'claude-carpool',
      channelId: 'claude-subscription',
      maxConcurrency: 4,
      runAsUser: 'fleet-agent-carpool',
      orgKind: 'carpool',
    },
    {
      id: 'metered',
      channelId: 'api-metered',
      maxConcurrency: 1,
    },
  ]);
});

const routeRow = async (id: string) => (await t.db.select().from(routes).where(eq(routes.id, id)))[0];

describe('读：每条路由探得了探不了的事实', () => {
  it('渠道、计费、池的会话用户和组织、模型、有没有阶段开着它、上一次的结论都读出来', async () => {
    await addRoute(t.db, {
      id: 'car',
      channelId: 'claude-subscription',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      alive: false,
      upstreamModel: 'claude-opus-5-5',
    });
    await addRoute(t.db, {
      id: 'meter',
      channelId: 'api-metered',
      poolId: 'metered',
      modelId: 'kimi-k3',
      alive: false,
    });
    await addRoute(t.db, { id: 'relay-opus', poolId: 'relay-a', modelId: 'opus-5.5', hostId: 'mirasim' });
    await setStageOrder(t.db, 'execute', ['car', 'relay-opus']);
    // relay-opus 在 execute 里关着：不算「有阶段开着它」
    await t.db
      .update(stagePolicyRoutes)
      .set({ enabled: false })
      .where(eq(stagePolicyRoutes.routeId, 'relay-opus'));

    const targets = await routeProbeTargets(t.db);
    expect(targets.map((x) => x.routeId)).toEqual(['car', 'meter', 'relay-opus']);
    const [car, meter, relay] = targets;
    expect(car).toMatchObject({
      hostId: 'claude-code',
      channelName: 'Claude 订阅',
      billing: 'subscription',
      channelEnabled: true,
      poolId: 'claude-carpool',
      runAsUser: 'fleet-agent-carpool',
      orgKind: 'carpool',
      modelName: 'Opus 5.5',
      upstreamModel: 'claude-opus-5-5',
      modelRetiredAt: null,
      inUse: true,
      alive: false,
      previous: null,
    });
    expect(meter).toMatchObject({ billing: 'metered', channelEnabled: false, inUse: false, runAsUser: null });
    // addRoute 建的在线路由带着探针的 ok 结论
    expect(relay).toMatchObject({
      hostId: 'mirasim',
      inUse: false,
      alive: true,
      previous: { state: 'ok', detail: '答上了：OK' },
    });
  });

  it('一条路由都没有：回空表（调用方记「没扫到」），不报错', async () => {
    expect(await routeProbeTargets(t.db)).toEqual([]);
  });
});

describe('写：一条路由的结论', () => {
  beforeEach(async () => {
    await addRoute(t.db, {
      id: 'car',
      channelId: 'claude-subscription',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      alive: false,
    });
  });

  it('ok 让它在线，结论、时刻、原因一起写；驾驶舱读到的是同一份', async () => {
    expect(await saveRouteProbe(t.db, { routeId: 'car', state: 'ok', at: NOW, detail: '答上了：OK' })).toBe(
      'saved',
    );
    const row = await routeRow('car');
    expect(row).toMatchObject({ alive: true, probeState: 'ok', probedAt: NOW, probeDetail: '答上了：OK' });
    expect(toRoute(row as typeof routes.$inferSelect).probe).toEqual({
      state: 'ok',
      at: NOW.toISOString(),
      detail: '答上了：OK',
    });
  });

  it('不是 ok 的一律不在线：探通过的路由下一轮没探通就下线，原因照写', async () => {
    await saveRouteProbe(t.db, { routeId: 'car', state: 'ok', at: NOW, detail: '答上了：OK' });
    const later = new Date(NOW.getTime() + 15 * MIN);
    for (const state of ['failed', 'not_wired', 'skipped'] as const) {
      await saveRouteProbe(t.db, { routeId: 'car', state, at: later, detail: `原因：${state}` });
      expect(await routeRow('car')).toMatchObject({
        alive: false,
        probeState: state,
        probedAt: later,
        probeDetail: `原因：${state}`,
      });
    }
  });

  it('路由这一轮当中被删了：回 route_not_found，不当成写好了', async () => {
    expect(await saveRouteProbe(t.db, { routeId: 'gone', state: 'ok', at: NOW, detail: '答上了：OK' })).toBe(
      'route_not_found',
    );
  });

  it('不是 ok 却没写原因：库里约束拒掉、原样抛出，不悄悄写成没原因的离线', async () => {
    await expect(
      saveRouteProbe(t.db, { routeId: 'car', state: 'failed', at: NOW, detail: '' }),
    ).rejects.toThrow();
    expect(await routeRow('car')).toMatchObject({ alive: false, probeState: null });
  });

  it('读出来的模型下架时刻、渠道开关照库里的', async () => {
    await t.db.update(models).set({ retiredAt: NOW }).where(eq(models.id, 'opus-5.5'));
    await t.db.update(channels).set({ enabled: false }).where(eq(channels.id, 'claude-subscription'));
    const [car] = await routeProbeTargets(t.db);
    expect(car).toMatchObject({ modelRetiredAt: NOW, channelEnabled: false });
  });
});
