// 驾驶舱「路由」页改先后和开关的接口（母单 #1089 第二片）：用途下的模型上移 / 下移、模型下的渠道上移 / 下移、渠道开关。
// 真库上写路由两层那两张表（position、enabled），和操作记录同一个事务；改完 /routing/layers 读回来的就是新顺序（引擎选路也读这两张表）。
// 没登录、没接上、别人先改了（看到的顺序对不上）、没有这一项、已在最上 / 最下、请求不合约定、网关通行证都拒，库里不动、不记操作记录。
import { auditLog, channels, routes, routingCatalog, routingPurposeModels } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import {
  MovePurposeModelResponse,
  RoutingLayersResponse,
  SetChannelEnabledResponse,
  SetModelEnabledResponse,
  UpdateModelRouteResponse,
} from '@fleet-dao/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgRoutingLayers } from '../src/routing-layers.ts';
import { pgRoutingOrder, type RoutingOrderPort } from '../src/routing-order.ts';
import { errorCode, harness, pgHarness, T0, viaGateway, write } from './harness.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let current: Awaited<ReturnType<typeof pgHarness>> | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});

/** 样例数据里挂成：写码 = Opus → Kimi → GPT；Opus 下两条渠道（Claude 订阅在前、Mirasim 在后），其余各一条。 */
async function hang() {
  await t.db.insert(routes).values({
    id: 'rt-mirasim-opus',
    channelId: 'ch-mirasim',
    poolId: 'pool-mirasim',
    modelId: 'opus-5.5',
    hostId: 'mirasim',
    alive: false,
  });
  await t.db.insert(routingPurposeModels).values([
    { purpose: 'execute', modelId: 'opus-5.5', position: 0 },
    { purpose: 'execute', modelId: 'kimi-k3', position: 1 },
    { purpose: 'execute', modelId: 'gpt-5.6', position: 2 },
    { purpose: 'review', modelId: 'gpt-5.6', position: 0 },
  ]);
  await t.db.insert(routingCatalog).values([
    { modelId: 'opus-5.5', routeId: 'rt-claude-opus', position: 0, enabled: true },
    { modelId: 'opus-5.5', routeId: 'rt-mirasim-opus', position: 1, enabled: true },
    { modelId: 'kimi-k3', routeId: 'rt-mirasim-kimi', position: 0, enabled: true },
    { modelId: 'gpt-5.6', routeId: 'rt-mirasim-gpt', position: 0, enabled: true },
  ]);
}

const withPorts = () => ({
  routingOrder: pgRoutingOrder(t.db, () => T0),
  routingLayers: pgRoutingLayers(t.db),
});

type Session = { cookie: string; csrf: string };
const putModel = (
  h: Awaited<ReturnType<typeof pgHarness>> | ReturnType<typeof harness>,
  s: Session,
  path: string,
  body: unknown,
) => h.cockpit.request(`/api/routing/purposes/${path}`, write('PUT', s, body));
const putRoute = (
  h: Awaited<ReturnType<typeof pgHarness>> | ReturnType<typeof harness>,
  s: Session,
  path: string,
  body: unknown,
) => h.cockpit.request(`/api/routing/models/${path}`, write('PUT', s, body));

const MODELS = ['opus-5.5', 'kimi-k3', 'gpt-5.6'];

const audits = async () =>
  (await t.db.select().from(auditLog)).filter(
    (a) => a.action.startsWith('routing.order.') || a.action === 'routing.route.enable',
  );

const dbModelOrder = async () =>
  (
    await t.db
      .select()
      .from(routingPurposeModels)
      .where(eq(routingPurposeModels.purpose, 'execute'))
      .orderBy(asc(routingPurposeModels.position))
  ).map((r) => r.modelId);

const dbRouteOrder = async () =>
  (
    await t.db
      .select()
      .from(routingCatalog)
      .where(eq(routingCatalog.modelId, 'opus-5.5'))
      .orderBy(asc(routingCatalog.position))
  ).map((r) => r.routeId);

describe('驾驶舱改路由先后：用途下的模型', () => {
  it('下移：写库、记操作记录；读回路由两层就是新顺序（引擎选路读的同一张表）', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();

    const res = await putModel(current, s, 'execute/models/opus-5.5', {
      direction: 'down',
      expected: MODELS,
      reason: 'Kimi 这周更稳',
    });
    expect(res.status).toBe(200);
    expect(MovePurposeModelResponse.parse(await res.json())).toEqual({
      purpose: 'execute',
      order: ['kimi-k3', 'opus-5.5', 'gpt-5.6'],
    });
    expect(await dbModelOrder()).toEqual(['kimi-k3', 'opus-5.5', 'gpt-5.6']);

    const layers = RoutingLayersResponse.parse(
      await (await current.cockpit.request('/api/routing/layers', { headers: { cookie: s.cookie } })).json(),
    );
    expect(layers.purposes.find((p) => p.purpose === 'execute')?.models.map((m) => m.modelId)).toEqual([
      'kimi-k3',
      'opus-5.5',
      'gpt-5.6',
    ]);
    expect(await audits()).toEqual([
      expect.objectContaining({
        actorKind: 'user',
        action: 'routing.order.move',
        target: 'stage:execute',
        before: { order: MODELS },
        after: { order: ['kimi-k3', 'opus-5.5', 'gpt-5.6'], moved: 'opus-5.5', direction: 'down' },
        reason: 'Kimi 这周更稳',
        via: 'cockpit',
        ok: true,
      }),
    ]);
  });

  it('上移：别的用途里的同一个模型不动', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const res = await putModel(current, s, 'execute/models/gpt-5.6', { direction: 'up', expected: MODELS });
    expect(res.status).toBe(200);
    expect(await dbModelOrder()).toEqual(['opus-5.5', 'gpt-5.6', 'kimi-k3']);
    expect(
      (await t.db.select().from(routingPurposeModels).where(eq(routingPurposeModels.purpose, 'review'))).map(
        (r) => [r.modelId, r.position],
      ),
    ).toEqual([['gpt-5.6', 0]]);
  });

  it('【故意造出的失败】没登录 401；飞书网关通行证 403（不在它能进的几条里）；都不动库', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const body = JSON.stringify({ direction: 'down', expected: MODELS });
    const anon = await current.cockpit.request('/api/routing/purposes/execute/models/opus-5.5', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(anon.status).toBe(401);
    const gateway = await current.cockpit.request(
      '/api/routing/purposes/execute/models/opus-5.5',
      viaGateway('PUT', 'ou_dev_founder_a', { direction: 'down', expected: MODELS }),
    );
    expect(gateway.status).toBe(403);
    expect(await errorCode(gateway)).toBe('gateway_route_not_allowed');
    expect(await dbModelOrder()).toEqual(MODELS);
    expect(await audits()).toEqual([]);
  });

  it('【故意造出的失败】看到的顺序已被别人改了：409 带库里现在的顺序，不覆盖、不记操作记录', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    await putModel(current, s, 'execute/models/opus-5.5', { direction: 'down', expected: MODELS });
    const stale = await putModel(current, s, 'execute/models/opus-5.5', {
      direction: 'down',
      expected: MODELS,
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale.clone())).toBe('conflict');
    expect(((await stale.json()) as { error: { details: unknown } }).error.details).toEqual({
      current: ['kimi-k3', 'opus-5.5', 'gpt-5.6'],
    });
    expect(await dbModelOrder()).toEqual(['kimi-k3', 'opus-5.5', 'gpt-5.6']);
    expect(await audits()).toHaveLength(1);
  });

  it('【故意造出的失败】已在最上 / 最下 422、模型不在这个用途里 404、不认识的用途 404、请求不合约定 400：库里不动', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const top = await putModel(current, s, 'execute/models/opus-5.5', { direction: 'up', expected: MODELS });
    expect(top.status).toBe(422);
    expect(await errorCode(top)).toBe('already_at_edge');
    const bottom = await putModel(current, s, 'execute/models/gpt-5.6', {
      direction: 'down',
      expected: MODELS,
    });
    expect(bottom.status).toBe(422);
    const missing = await putModel(current, s, 'review/models/opus-5.5', {
      direction: 'down',
      expected: ['gpt-5.6'],
    });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('model_not_found');
    const noPurpose = await putModel(current, s, 'nope/models/opus-5.5', {
      direction: 'down',
      expected: MODELS,
    });
    expect(noPurpose.status).toBe(404);
    expect(await errorCode(noPurpose)).toBe('purpose_not_found');
    const bad = await putModel(current, s, 'execute/models/opus-5.5', {
      direction: 'sideways',
      expected: MODELS,
    });
    expect(bad.status).toBe(400);
    const noExpected = await putModel(current, s, 'execute/models/opus-5.5', { direction: 'down' });
    expect(noExpected.status).toBe(400);
    expect(await dbModelOrder()).toEqual(MODELS);
    expect(await audits()).toEqual([]);
  });

  it('【故意造出的失败】没接上（开发环境、内存版）：503 说明，不当改成了', async () => {
    const h = harness();
    const s = await h.login();
    const res = await putModel(h, s, 'execute/models/opus-5.5', { direction: 'down', expected: MODELS });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('routing_order_not_wired');
  });

  it('【故意造出的失败】写不进库：503 写明原因，不当改成了', async () => {
    const broken: RoutingOrderPort = {
      movePurposeModel: async () => {
        throw new Error('connection terminated');
      },
      moveModelRoute: async () => {
        throw new Error('不该走到这');
      },
      setRouteEnabled: async () => {
        throw new Error('不该走到这');
      },
      reorderPurposeModels: async () => {
        throw new Error('不该走到这');
      },
      reorderModelRoutes: async () => {
        throw new Error('不该走到这');
      },
      setModelEnabled: async () => {
        throw new Error('不该走到这');
      },
      setChannelEnabled: async () => {
        throw new Error('不该走到这');
      },
      subjectsOf: async () => ({ model: undefined, routes: [] }),
    };
    current = await pgHarness(t, { routingOrder: broken });
    const s = await current.login();
    const res = await putModel(current, s, 'execute/models/opus-5.5', {
      direction: 'down',
      expected: MODELS,
    });
    expect(res.status).toBe(503);
    expect(await errorCode(res.clone())).toBe('routing_order_unwritable');
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'connection terminated',
    );
  });
});

describe('驾驶舱改路由先后：模型下的渠道和开关', () => {
  it('渠道下移：写库、记操作记录（对象是模型）；读回路由两层是新顺序', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const res = await putRoute(current, s, 'opus-5.5/routes/rt-claude-opus', {
      op: 'move',
      direction: 'down',
      expected: ['rt-claude-opus', 'rt-mirasim-opus'],
    });
    expect(res.status).toBe(200);
    expect(UpdateModelRouteResponse.parse(await res.json())).toEqual({
      modelId: 'opus-5.5',
      routeId: 'rt-claude-opus',
      order: ['rt-mirasim-opus', 'rt-claude-opus'],
    });
    expect(await dbRouteOrder()).toEqual(['rt-mirasim-opus', 'rt-claude-opus']);
    const layers = RoutingLayersResponse.parse(
      await (await current.cockpit.request('/api/routing/layers', { headers: { cookie: s.cookie } })).json(),
    );
    expect(
      layers.purposes
        .find((p) => p.purpose === 'execute')
        ?.models.find((m) => m.modelId === 'opus-5.5')
        ?.routes.map((r) => r.routeId),
    ).toEqual(['rt-mirasim-opus', 'rt-claude-opus']);
    expect(await audits()).toEqual([
      expect.objectContaining({
        action: 'routing.order.move',
        target: 'model:opus-5.5',
        before: { order: ['rt-claude-opus', 'rt-mirasim-opus'] },
        after: {
          order: ['rt-mirasim-opus', 'rt-claude-opus'],
          moved: 'rt-claude-opus',
          direction: 'down',
        },
        via: 'cockpit',
      }),
    ]);
  });

  it('渠道开关：关了写库、记操作记录；路由两层里这条标成关着；再开回来', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const off = await putRoute(current, s, 'opus-5.5/routes/rt-mirasim-opus', {
      op: 'enable',
      enabled: false,
      expected: true,
      reason: '这条中转额度紧',
    });
    expect(off.status).toBe(200);
    expect(UpdateModelRouteResponse.parse(await off.json())).toEqual({
      modelId: 'opus-5.5',
      routeId: 'rt-mirasim-opus',
      enabled: false,
    });
    const row = async () =>
      (
        await t.db
          .select()
          .from(routingCatalog)
          .where(and(eq(routingCatalog.modelId, 'opus-5.5'), eq(routingCatalog.routeId, 'rt-mirasim-opus')))
      )[0];
    expect(await row()).toMatchObject({ enabled: false, position: 1 });
    const layers = RoutingLayersResponse.parse(
      await (await current.cockpit.request('/api/routing/layers', { headers: { cookie: s.cookie } })).json(),
    );
    expect(
      layers.purposes
        .find((p) => p.purpose === 'execute')
        ?.models.find((m) => m.modelId === 'opus-5.5')
        ?.routes.find((r) => r.routeId === 'rt-mirasim-opus')?.enabled,
    ).toBe(false);
    expect(await audits()).toEqual([
      expect.objectContaining({
        action: 'routing.route.enable',
        target: 'route:rt-mirasim-opus',
        before: { modelId: 'opus-5.5', enabled: true },
        after: { modelId: 'opus-5.5', enabled: false },
        reason: '这条中转额度紧',
      }),
    ]);
    const on = await putRoute(current, s, 'opus-5.5/routes/rt-mirasim-opus', {
      op: 'enable',
      enabled: true,
      expected: false,
    });
    expect(on.status).toBe(200);
    expect(await row()).toMatchObject({ enabled: true });
  });

  it('【故意造出的失败】没登录 401、网关通行证 403、不存在的渠道 404、已在最下 422、请求不合约定 400：库里不动', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const anon = await current.cockpit.request('/api/routing/models/opus-5.5/routes/rt-claude-opus', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'enable', enabled: false, expected: true }),
    });
    expect(anon.status).toBe(401);
    const gateway = await current.cockpit.request(
      '/api/routing/models/opus-5.5/routes/rt-claude-opus',
      viaGateway('PUT', 'ou_dev_founder_a', { op: 'enable', enabled: false, expected: true }),
    );
    expect(gateway.status).toBe(403);
    expect(await errorCode(gateway)).toBe('gateway_route_not_allowed');

    const missingMove = await putRoute(current, s, 'opus-5.5/routes/nope', {
      op: 'move',
      direction: 'up',
      expected: ['rt-claude-opus', 'rt-mirasim-opus'],
    });
    expect(missingMove.status).toBe(404);
    expect(await errorCode(missingMove)).toBe('route_not_found');
    // 路由有，但不是这个模型下的
    const wrongModel = await putRoute(current, s, 'opus-5.5/routes/rt-mirasim-kimi', {
      op: 'enable',
      enabled: false,
      expected: true,
    });
    expect(wrongModel.status).toBe(404);
    expect(await errorCode(wrongModel)).toBe('route_not_found');

    const bottom = await putRoute(current, s, 'opus-5.5/routes/rt-mirasim-opus', {
      op: 'move',
      direction: 'down',
      expected: ['rt-claude-opus', 'rt-mirasim-opus'],
    });
    expect(bottom.status).toBe(422);
    expect(await errorCode(bottom)).toBe('already_at_edge');
    const bad = await putRoute(current, s, 'opus-5.5/routes/rt-claude-opus', { op: 'enable', enabled: 'no' });
    expect(bad.status).toBe(400);

    expect(await dbRouteOrder()).toEqual(['rt-claude-opus', 'rt-mirasim-opus']);
    expect((await t.db.select().from(routingCatalog)).every((r) => r.enabled)).toBe(true);
    expect(await audits()).toEqual([]);
  });

  it('【故意造出的失败】看到的顺序 / 开关已被别人改了：409 带库里现在的值，不覆盖、不记操作记录', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const order = ['rt-claude-opus', 'rt-mirasim-opus'];
    await putRoute(current, s, 'opus-5.5/routes/rt-claude-opus', {
      op: 'move',
      direction: 'down',
      expected: order,
    });
    const staleMove = await putRoute(current, s, 'opus-5.5/routes/rt-claude-opus', {
      op: 'move',
      direction: 'down',
      expected: order,
    });
    expect(staleMove.status).toBe(409);
    expect(((await staleMove.json()) as { error: { details: unknown } }).error.details).toEqual({
      current: ['rt-mirasim-opus', 'rt-claude-opus'],
    });

    await putRoute(current, s, 'opus-5.5/routes/rt-claude-opus', {
      op: 'enable',
      enabled: false,
      expected: true,
    });
    const staleToggle = await putRoute(current, s, 'opus-5.5/routes/rt-claude-opus', {
      op: 'enable',
      enabled: true,
      expected: true,
    });
    expect(staleToggle.status).toBe(409);
    expect(((await staleToggle.json()) as { error: { details: unknown } }).error.details).toEqual({
      current: false,
    });
    // 只有两次真改成的记了
    expect((await audits()).map((a) => a.action)).toEqual(['routing.order.move', 'routing.route.enable']);
  });

  it('【故意造出的失败】没接上（内存版）503；写不进库 503 写明原因', async () => {
    const h = harness();
    const s = await h.login();
    const res = await putRoute(h, s, 'opus-5.5/routes/rt-claude-opus', {
      op: 'enable',
      enabled: false,
      expected: true,
    });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('routing_order_not_wired');

    const broken: RoutingOrderPort = {
      movePurposeModel: async () => {
        throw new Error('不该走到这');
      },
      moveModelRoute: async () => {
        throw new Error('deadlock detected');
      },
      setRouteEnabled: async () => {
        throw new Error('deadlock detected');
      },
      reorderPurposeModels: async () => {
        throw new Error('不该走到这');
      },
      reorderModelRoutes: async () => {
        throw new Error('deadlock detected');
      },
      setModelEnabled: async () => {
        throw new Error('不该走到这');
      },
      setChannelEnabled: async () => {
        throw new Error('不该走到这');
      },
      subjectsOf: async () => ({ model: undefined, routes: [] }),
    };
    current = await pgHarness(t, { routingOrder: broken });
    const s2 = await current.login();
    const moved = await putRoute(current, s2, 'opus-5.5/routes/rt-claude-opus', {
      op: 'move',
      direction: 'down',
      expected: ['rt-claude-opus', 'rt-mirasim-opus'],
    });
    expect(moved.status).toBe(503);
    expect(await errorCode(moved)).toBe('routing_order_unwritable');
  });
});

describe('驾驶舱：拖到新位置、模型开关、渠道开关', () => {
  it('拖动模型：一次写成新先后并记操作记录；路由两层读回来就是这个顺序', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const order = ['gpt-5.6', 'opus-5.5', 'kimi-k3'];
    const res = await putModel(current, s, 'execute/models/opus-5.5', { order, expected: MODELS });
    expect(res.status).toBe(200);
    expect(MovePurposeModelResponse.parse(await res.json())).toEqual({ purpose: 'execute', order });
    expect(await dbModelOrder()).toEqual(order);
    const rows = (await audits()).filter((a) => a.action === 'routing.order.move');
    expect(rows).toEqual([
      expect.objectContaining({
        target: 'stage:execute',
        before: { order: MODELS },
        after: { order, moved: 'opus-5.5' },
      }),
    ]);
  });

  it('关掉模型：这个模型下的路由都关着，路由两层写「开关关着」；再开全部打开', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const off = await putRoute(current, s, 'opus-5.5', {
      enabled: false,
      expectedEnabled: ['rt-claude-opus', 'rt-mirasim-opus'],
    });
    expect(off.status).toBe(200);
    expect(SetModelEnabledResponse.parse(await off.json())).toEqual({
      modelId: 'opus-5.5',
      enabled: false,
      enabledRouteIds: [],
    });
    const layers = RoutingLayersResponse.parse(
      await (await current.cockpit.request('/api/routing/layers', { headers: { cookie: s.cookie } })).json(),
    );
    const opus = layers.purposes
      .find((p) => p.purpose === 'execute')
      ?.models.find((m) => m.modelId === 'opus-5.5');
    expect(opus?.routes.every((r) => r.enabled === false && r.ban.reason.includes('开关关着'))).toBe(true);
    const logged = await t.db.select().from(auditLog);
    expect(logged.some((a) => a.action === 'routing.model.enable' && a.target === 'model:opus-5.5')).toBe(
      true,
    );
  });

  it('关掉渠道：channels.enabled 变成关，路由两层写「渠道关了」；看到的开关过期不覆盖', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const res = await current.cockpit.request(
      '/api/routing/channels/ch-mirasim',
      write('PUT', s, { enabled: false, expected: true, reason: '324 账号被封' }),
    );
    expect(res.status).toBe(200);
    expect(SetChannelEnabledResponse.parse(await res.json())).toEqual({
      channelId: 'ch-mirasim',
      enabled: false,
    });
    expect((await t.db.select().from(channels).where(eq(channels.id, 'ch-mirasim')))[0]?.enabled).toBe(false);
    const layers = RoutingLayersResponse.parse(
      await (await current.cockpit.request('/api/routing/layers', { headers: { cookie: s.cookie } })).json(),
    );
    const mirasim = layers.purposes
      .flatMap((p) => p.models.flatMap((m) => m.routes))
      .filter((r) => r.channelId === 'ch-mirasim');
    expect(mirasim.length).toBeGreaterThan(0);
    expect(mirasim.every((r) => r.connect.reason === '渠道关了')).toBe(true);
    const stale = await current.cockpit.request(
      '/api/routing/channels/ch-mirasim',
      write('PUT', s, { enabled: true, expected: true }),
    );
    expect(stale.status).toBe(409);
    expect((await t.db.select().from(channels).where(eq(channels.id, 'ch-mirasim')))[0]?.enabled).toBe(false);
    const logged = await t.db.select().from(auditLog);
    expect(logged.some((a) => a.action === 'channel.disable' && a.target === 'channel:ch-mirasim')).toBe(
      true,
    );
  });

  it('【故意造出的失败】新先后不是重排：422，库里的顺序不动', async () => {
    current = await pgHarness(t, withPorts());
    await hang();
    const s = await current.login();
    const res = await putModel(current, s, 'execute/models/opus-5.5', {
      order: ['opus-5.5', 'opus-5.5'],
      expected: MODELS,
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('order_invalid');
    expect(await dbModelOrder()).toEqual(MODELS);
  });
});
