// 路由探针的读写（#129）：读出每条路由探得了探不了的事实；写结论时只有 ok 让它在线、写不进去的明确报错。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toRoute } from '../src/domain-map.ts';
import {
  backfillProbeHistoryFromRoutes,
  ROUTE_PROBE_HISTORY_KEEP,
  ROUTE_PROBE_HISTORY_TEXT_MAX,
  readProbeHistoryJoined,
  readRouteProbeHistory,
  routeProbeTargets,
  saveRouteProbe,
} from '../src/queries/probe.ts';
import { channels, models, pools, routes, routingCatalog } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRoute, catalog, MIN, NOW, setRoutingLayers } from './helpers.ts';

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
  it('渠道、计费、池的会话用户和组织、模型、在不在用（路由两层里开着、模型排进了用途）、上一次的结论都读出来', async () => {
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
    await addRoute(t.db, { id: 'k3', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
    await setRoutingLayers(t.db, {
      purposes: { execute: ['opus-5.5'] },
      models: { 'opus-5.5': ['car', 'relay-opus'], 'kimi-k3': ['k3'] },
    });
    // relay-opus 在它的模型下关着：不算在用
    await t.db.update(routingCatalog).set({ enabled: false }).where(eq(routingCatalog.routeId, 'relay-opus'));

    const targets = await routeProbeTargets(t.db);
    expect(targets.map((x) => x.routeId)).toEqual(['car', 'k3', 'meter', 'relay-opus']);
    const [car, k3, meter, relay] = targets;
    // k3 在它的模型下开着，可 kimi-k3 没排进任何用途：选路派不到它，也不算在用
    expect(k3).toMatchObject({ inUse: false });
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

  it('Claude 订阅池的结论连那时挂的组织一起写（#335）；下一次没给就写空，不留上一次的', async () => {
    await saveRouteProbe(t.db, {
      routeId: 'car',
      state: 'skipped',
      at: NOW,
      detail: '会话用户现在挂的是独享组织：不探',
      org: 'solo',
    });
    expect(await routeRow('car')).toMatchObject({ alive: false, probeState: 'skipped', probeOrg: 'solo' });
    const later = new Date(NOW.getTime() + 15 * MIN);
    await saveRouteProbe(t.db, {
      routeId: 'car',
      state: 'ok',
      at: later,
      detail: '答上了：OK',
      org: 'carpool',
    });
    expect(await routeRow('car')).toMatchObject({ alive: true, probeState: 'ok', probeOrg: 'carpool' });
    await saveRouteProbe(t.db, { routeId: 'car', state: 'failed', at: later, detail: '组织认不出：不探' });
    expect(await routeRow('car')).toMatchObject({ alive: false, probeState: 'failed', probeOrg: null });
  });

  it('【故意造出的失败】那时挂的组织认不出（不是拼车、独享）：库里约束拒掉、原样抛出，结论不写一半', async () => {
    await expect(
      saveRouteProbe(t.db, {
        routeId: 'car',
        state: 'skipped',
        at: NOW,
        detail: '不探',
        org: 'enterprise' as never,
      }),
    ).rejects.toThrow();
    expect(await routeRow('car')).toMatchObject({ alive: false, probeState: null, probeOrg: null });
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

  it('路由已经没了：不写历史', async () => {
    expect(await saveRouteProbe(t.db, { routeId: 'gone', state: 'ok', at: NOW, detail: '答上了：OK' })).toBe(
      'route_not_found',
    );
    expect(await readRouteProbeHistory(t.db, 'gone', 10)).toEqual([]);
  });

  it('读出来的模型下架时刻、渠道开关照库里的', async () => {
    await t.db.update(models).set({ retiredAt: NOW }).where(eq(models.id, 'opus-5.5'));
    await t.db.update(channels).set({ enabled: false }).where(eq(channels.id, 'claude-subscription'));
    const [car] = await routeProbeTargets(t.db);
    expect(car).toMatchObject({ modelRetiredAt: NOW, channelEnabled: false });
  });
});

describe('探针历史', () => {
  beforeEach(async () => {
    await addRoute(t.db, {
      id: 'car',
      channelId: 'claude-subscription',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      alive: false,
    });
  });

  const at = (n: number) => new Date(NOW.getTime() + n * 1000);

  it('三态都写得进、读得回；没给的耗时和原文是空，不是 0 或空串', async () => {
    await saveRouteProbe(t.db, {
      routeId: 'car',
      state: 'ok',
      at: at(1),
      detail: '答上了：OK',
      durationMs: 1500,
      requestText: '问一句',
      responseText: 'OK',
    });
    await saveRouteProbe(t.db, { routeId: 'car', state: 'failed', at: at(2), detail: '连不上' });
    await saveRouteProbe(t.db, {
      routeId: 'car',
      state: 'skipped',
      at: at(3),
      detail: '按规矩不探',
      durationMs: 0,
    });
    await saveRouteProbe(t.db, { routeId: 'car', state: 'not_wired', at: at(4), detail: '插头没接' });

    const all = await readRouteProbeHistory(t.db, 'car', 10);
    expect(all.map((row) => row.result)).toEqual(['not_probed', 'not_probed', 'failed', 'passed']);
    expect(all[0]).toMatchObject({
      failureReason: '插头没接',
      durationMs: null,
      requestText: null,
      responseText: null,
    });
    expect(all[1]).toMatchObject({ failureReason: '按规矩不探', durationMs: 0 });
    expect(all[2]).toMatchObject({
      failureReason: '连不上',
      durationMs: null,
      requestText: null,
      responseText: null,
    });
    expect(all[3]).toMatchObject({
      result: 'passed',
      failureReason: null,
      durationMs: 1500,
      requestText: '问一句',
      responseText: 'OK',
    });
    expect(await readRouteProbeHistory(t.db, 'car', 2)).toEqual(all.slice(0, 2));
  });

  it('超过 60 条只留最近的；更早写进去的、以及别的路由，都不被这轮裁掉不该裁的', async () => {
    await addRoute(t.db, {
      id: 'other',
      channelId: 'api-metered',
      poolId: 'metered',
      modelId: 'kimi-k3',
      alive: false,
    });
    await saveRouteProbe(t.db, { routeId: 'other', state: 'failed', at: NOW, detail: '别的路由' });
    for (let i = 1; i <= ROUTE_PROBE_HISTORY_KEEP + 1; i++) {
      await saveRouteProbe(t.db, {
        routeId: 'car',
        state: 'ok',
        at: at(i),
        detail: '答上了：OK',
        durationMs: i,
      });
    }
    const kept = await readRouteProbeHistory(t.db, 'car', ROUTE_PROBE_HISTORY_KEEP + 10);
    expect(kept).toHaveLength(ROUTE_PROBE_HISTORY_KEEP);
    expect(kept.map((row) => row.durationMs)).toEqual(
      Array.from({ length: ROUTE_PROBE_HISTORY_KEEP }, (_, i) => ROUTE_PROBE_HISTORY_KEEP + 1 - i),
    );
    expect(await readRouteProbeHistory(t.db, 'other', 10)).toMatchObject([
      { result: 'failed', failureReason: '别的路由' },
    ]);

    await saveRouteProbe(t.db, {
      routeId: 'car',
      state: 'failed',
      at: new Date(NOW.getTime() - 1000),
      detail: '这条更早',
      durationMs: 0,
    });
    const afterOld = await readRouteProbeHistory(t.db, 'car', ROUTE_PROBE_HISTORY_KEEP + 10);
    expect(afterOld).toHaveLength(ROUTE_PROBE_HISTORY_KEEP);
    expect(afterOld.some((row) => row.durationMs === 0)).toBe(false);
    expect(afterOld[0]?.durationMs).toBe(ROUTE_PROBE_HISTORY_KEEP + 1);
  });

  it('同一事务：写成功时路由和历史一起在；约束拒了就一起退回', async () => {
    expect(
      await saveRouteProbe(t.db, {
        routeId: 'car',
        state: 'ok',
        at: NOW,
        detail: '答上了：OK',
        durationMs: 10,
      }),
    ).toBe('saved');
    expect(await routeRow('car')).toMatchObject({ alive: true, probeState: 'ok' });
    expect(await readRouteProbeHistory(t.db, 'car', 10)).toMatchObject([
      { result: 'passed', durationMs: 10 },
    ]);

    await expect(
      saveRouteProbe(t.db, {
        routeId: 'car',
        state: 'skipped',
        at: at(1),
        detail: '不探',
        org: 'enterprise' as never,
      }),
    ).rejects.toThrow();
    expect(await routeRow('car')).toMatchObject({ alive: true, probeState: 'ok', probeOrg: null });
    expect(await readRouteProbeHistory(t.db, 'car', 10)).toHaveLength(1);

    await expect(
      saveRouteProbe(t.db, {
        routeId: 'car',
        state: 'failed',
        at: at(2),
        detail: '耗时是负的',
        durationMs: -1,
      }),
    ).rejects.toThrow();
    expect(await routeRow('car')).toMatchObject({ alive: true, probeState: 'ok', probeDetail: '答上了：OK' });
    const left = await readRouteProbeHistory(t.db, 'car', 10);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ result: 'passed', durationMs: 10 });
  });

  it('请求和响应超长就截断，并标明原文多长', async () => {
    const raw = `错${'x'.repeat(ROUTE_PROBE_HISTORY_TEXT_MAX)}`;
    await saveRouteProbe(t.db, {
      routeId: 'car',
      state: 'failed',
      at: NOW,
      detail: '连不上',
      requestText: raw,
      responseText: raw,
    });
    const [row] = await readRouteProbeHistory(t.db, 'car', 1);
    for (const text of [row?.requestText, row?.responseText]) {
      expect(text?.startsWith('错')).toBe(true);
      expect(text).toContain('已截断');
      expect(text).toContain(`原文 ${raw.length} 字`);
      expect(text?.length).toBeLessThanOrEqual(ROUTE_PROBE_HISTORY_TEXT_MAX);
      expect(text).not.toBe(raw);
    }
  });

  it('【故意造出的失败】历史表读不到：抛错，不回空数组冒充没有历史', async () => {
    expect(await readRouteProbeHistory(t.db, 'car', 10)).toEqual([]);
    await t.client.exec('alter table route_probe_history rename to route_probe_history_unreadable');
    try {
      await expect(readRouteProbeHistory(t.db, 'car', 10)).rejects.toThrow(/读不到/);
      const err = await readRouteProbeHistory(t.db, 'car', 10).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('route_probe_history');
      await expect(readProbeHistoryJoined(t.db)).rejects.toThrow(/读不到探针历史/);
    } finally {
      await t.client.exec('alter table route_probe_history_unreadable rename to route_probe_history');
    }
  });

  it('老结论回填一条：耗时从「用时 N 秒」还原，再跑一次不重复；按渠道读得回', async () => {
    await t.db
      .update(routes)
      .set({
        alive: true,
        probeState: 'ok',
        probedAt: NOW,
        probeDetail: '答上了：OK · 用时 9 秒',
      })
      .where(eq(routes.id, 'car'));
    await addRoute(t.db, {
      id: 'meter',
      channelId: 'api-metered',
      poolId: 'metered',
      modelId: 'kimi-k3',
      alive: false,
    });
    await t.db
      .update(routes)
      .set({ probeState: 'skipped', probedAt: at(1), probeDetail: '按量计费，不自动探' })
      .where(eq(routes.id, 'meter'));

    expect(await backfillProbeHistoryFromRoutes(t.db)).toBe(2);
    expect(await backfillProbeHistoryFromRoutes(t.db)).toBe(0);

    const joined = await readProbeHistoryJoined(t.db);
    expect(joined).toMatchObject([
      {
        routeId: 'car',
        channelId: 'claude-subscription',
        result: 'passed',
        durationMs: 9000,
        failureReason: null,
        requestText: null,
        responseText: null,
      },
      {
        routeId: 'meter',
        channelId: 'api-metered',
        result: 'not_probed',
        durationMs: null,
        failureReason: '按量计费，不自动探',
      },
    ]);
  });
});
