// 决定 0033：Fable 进目录，只有创始人本人在驾驶舱能把它的路由 / 模型打开（或配进用途）；引擎、临时指挥官、fleet-api 命令、
// 机器通行证一律拒并写明原因。判法在 shared 的 founderOnlyDenial，接口在 founder-only.ts。
// 两道门都测：① 真应用（登录 Cookie 才进得来，网关通行证 / fleet 令牌被中间件挡）；② 把非创始人的调用方硬塞到接口前面
// （模拟哪天有人把接口放给网关或令牌），接口自己还是拒。
import { auditLog, routingCatalog, routingPurposeModels } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.ts';
import { guardFounderOnly, operatorOf } from '../src/founder-only.ts';
import { ApiError, errorHandler } from '../src/http.ts';
import { pgRoutingOrder, registerRoutingOrderRoutes } from '../src/routing-order.ts';
import type { CockpitEnv } from '../src/session.ts';
import { errorCode, pgHarness, T0, viaGateway, write } from './harness.ts';

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

const ports = () => ({ routingOrder: pgRoutingOrder(t.db, () => T0) });

/** 样例库里有 fable-5.1 和它的路由 rt-mirasim-fable。入库默认：路由表里关着，不在任何用途里。 */
async function fableCatalogClosed() {
  await t.db.insert(routingCatalog).values([
    { modelId: 'fable-5.1', routeId: 'rt-mirasim-fable', position: 0, enabled: false },
    { modelId: 'opus-5.5', routeId: 'rt-claude-opus', position: 0, enabled: true },
  ]);
  await t.db.insert(routingPurposeModels).values([{ purpose: 'execute', modelId: 'opus-5.5', position: 0 }]);
}

const fableEnabled = async () =>
  (await t.db.select().from(routingCatalog)).find((r) => r.routeId === 'rt-mirasim-fable')?.enabled;
const enableAudits = async () =>
  (await t.db.select().from(auditLog)).filter((a) => a.action.startsWith('routing.'));

const OPEN_ROUTE = { op: 'enable', enabled: true, expected: false, reason: '创始人自己要试 Fable' };
const OPEN_MODEL = { enabled: true, expectedEnabled: [], reason: '创始人自己要试 Fable' };

describe('创始人本人在驾驶舱：能打开 Fable，进操作记录', () => {
  it('打开路由：写库、记 routing.route.enable、操作人是登录的创始人、via=cockpit', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const s = await current.login();
    const res = await current.cockpit.request(
      '/api/routing/models/fable-5.1/routes/rt-mirasim-fable',
      write('PUT', s, OPEN_ROUTE),
    );
    expect(res.status).toBe(200);
    expect(await fableEnabled()).toBe(true);
    expect(await enableAudits()).toEqual([
      expect.objectContaining({
        actorKind: 'user',
        action: 'routing.route.enable',
        target: 'route:rt-mirasim-fable',
        before: { modelId: 'fable-5.1', enabled: false },
        after: { modelId: 'fable-5.1', enabled: true },
        via: 'cockpit',
        ok: true,
      }),
    ]);
  });

  it('打开模型：整个模型的路由一起开，记 routing.model.enable', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const s = await current.login();
    const res = await current.cockpit.request('/api/routing/models/fable-5.1', write('PUT', s, OPEN_MODEL));
    expect(res.status).toBe(200);
    expect(await fableEnabled()).toBe(true);
    expect((await enableAudits()).map((a) => [a.action, a.via])).toEqual([
      ['routing.model.enable', 'cockpit'],
    ]);
  });

  it('关掉 Fable 谁都能关（往安全那边改）：不过创始人这道门', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const s = await current.login();
    await current.cockpit.request(
      '/api/routing/models/fable-5.1/routes/rt-mirasim-fable',
      write('PUT', s, OPEN_ROUTE),
    );
    const close = await current.cockpit.request(
      '/api/routing/models/fable-5.1/routes/rt-mirasim-fable',
      write('PUT', s, { op: 'enable', enabled: false, expected: true }),
    );
    expect(close.status).toBe(200);
    expect(await fableEnabled()).toBe(false);
  });
});

describe('第一道门：真应用里，机器通行证和令牌碰不到开关', () => {
  it('【故意造出的失败】机器通行证（飞书网关）调开关接口打开 Fable：必须被拒，库里还是关着，不记操作记录', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const route = await current.cockpit.request(
      '/api/routing/models/fable-5.1/routes/rt-mirasim-fable',
      viaGateway('PUT', 'ou_dev_founder_a', OPEN_ROUTE),
    );
    expect(route.status).toBe(403);
    expect(await errorCode(route)).toBe('gateway_route_not_allowed');
    const model = await current.cockpit.request(
      '/api/routing/models/fable-5.1',
      viaGateway('PUT', 'ou_dev_founder_a', OPEN_MODEL),
    );
    expect(model.status).toBe(403);
    expect(await fableEnabled()).toBe(false);
    expect(await enableAudits()).toEqual([]);
  });

  it('【故意造出的失败】fleet 令牌（fleet-api / 引擎用的）、没登录：拒，库里不动', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const token = current.agentToken();
    const viaToken = await current.cockpit.request('/api/routing/models/fable-5.1', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(OPEN_MODEL),
    });
    expect(viaToken.status).toBe(401);
    const anon = await current.cockpit.request('/api/routing/models/fable-5.1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(OPEN_MODEL),
    });
    expect(anon.status).toBe(401);
    expect(await fableEnabled()).toBe(false);
    expect(await enableAudits()).toEqual([]);
  });
});

/** 把指定的调用方硬塞到接口前面：模拟哪天有人把这几条接口放给网关通行证或别的非登录来路。 */
function appAs(who: { via: 'cockpit' | 'feishu'; session: object | undefined }) {
  const app = new Hono<CockpitEnv>();
  app.onError(errorHandler({ info() {}, warn() {}, error() {} }));
  app.use('*', async (c, next) => {
    c.set('user', { id: 'founder-a', role: 'founder', active: true } as never);
    c.set('via', who.via);
    c.set('session', who.session as never);
    await next();
  });
  const deps = {
    routingOrder: pgRoutingOrder(t.db, () => T0),
    log: { info() {}, warn() {}, error() {} },
  } as unknown as Deps;
  registerRoutingOrderRoutes(app, deps, (c) => ({ kind: 'user', id: c.get('user').id }));
  return app;
}
const putJson = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('第二道门：接口自己也拒非创始人本人', () => {
  it('【故意造出的失败】网关通行证来路打开 Fable 路由 / 模型：403 founder_only，原因写明，库里不动', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const app = appAs({ via: 'feishu', session: undefined });
    const route = await app.request('/routing/models/fable-5.1/routes/rt-mirasim-fable', putJson(OPEN_ROUTE));
    expect(route.status).toBe(403);
    const body = (await route.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('founder_only');
    expect(body.error.message).toContain('只有创始人本人在驾驶舱');
    expect(body.error.message).toContain('飞书网关通行证');
    const model = await app.request('/routing/models/fable-5.1', putJson(OPEN_MODEL));
    expect(model.status).toBe(403);
    expect(await fableEnabled()).toBe(false);
    expect(await enableAudits()).toEqual([]);
  });

  it('【故意造出的失败】同一来路拖动 Fable 在用途里的先后：也拒', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    await t.db
      .insert(routingPurposeModels)
      .values([{ purpose: 'execute', modelId: 'fable-5.1', position: 1 }]);
    const app = appAs({ via: 'feishu', session: undefined });
    const res = await app.request(
      '/routing/purposes/execute/models/fable-5.1',
      putJson({ direction: 'up', expected: ['opus-5.5', 'fable-5.1'] }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('founder_only');
    expect(
      (await t.db.select().from(routingPurposeModels)).map((r) => [r.modelId, r.position]).sort(),
    ).toEqual([
      ['fable-5.1', 1],
      ['opus-5.5', 0],
    ]);
  });

  it('【故意造出的失败】同一来路把 Fable 加进用途：403 founder_only，用途里还是没有它', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const app = appAs({ via: 'feishu', session: undefined });
    const res = await app.request('/routing/purposes/ui/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'fable-5.1', version: 0 }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('founder_only');
    expect(body.error.message).toContain('只有创始人本人在驾驶舱');
    expect((await t.db.select().from(routingPurposeModels)).map((r) => r.modelId)).toEqual(['opus-5.5']);
    expect(await enableAudits()).toEqual([]);
  });

  it('有浏览器登录态的创始人来路可以把 Fable 加进用途', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const app = appAs({ via: 'cockpit', session: { sid: 's' } });
    const res = await app.request('/routing/purposes/ui/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'fable-5.1', version: 0, reason: '创始人自己要试' }),
    });
    expect(res.status).toBe(200);
    expect(
      (await t.db.select().from(routingPurposeModels))
        .filter((r) => r.purpose === 'ui')
        .map((r) => r.modelId),
    ).toEqual(['fable-5.1']);
  });

  it('非创始人来路开别的模型、关 Fable 都不受这道门管', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const app = appAs({ via: 'feishu', session: undefined });
    const opus = await app.request(
      '/routing/models/opus-5.5/routes/rt-claude-opus',
      putJson({ op: 'enable', enabled: false, expected: true }),
    );
    expect(opus.status).toBe(200);
    const fableClose = await app.request(
      '/routing/models/fable-5.1/routes/rt-mirasim-fable',
      putJson({ op: 'enable', enabled: false, expected: false }),
    );
    expect(fableClose.status).toBe(200);
  });

  it('有浏览器登录态的创始人来路放行', async () => {
    current = await pgHarness(t, ports());
    await fableCatalogClosed();
    const app = appAs({ via: 'cockpit', session: { sid: 's' } });
    const res = await app.request('/routing/models/fable-5.1', putJson(OPEN_MODEL));
    expect(res.status).toBe(200);
    expect(await fableEnabled()).toBe(true);
  });
});

describe('门本身（founder-only.ts）', () => {
  const ctx = (via: string, session: unknown) =>
    ({ get: (k: string) => ({ via, session })[k] }) as unknown as Parameters<typeof operatorOf>[0];

  it('只有 via=cockpit 且有浏览器会话才算创始人本人', () => {
    expect(operatorOf(ctx('cockpit', { sid: 's' })).founderInCockpit).toBe(true);
    expect(operatorOf(ctx('cockpit', undefined)).founderInCockpit).toBe(false);
    expect(operatorOf(ctx('feishu', undefined))).toEqual({
      label: '飞书网关通行证',
      founderInCockpit: false,
    });
  });

  it('路由带的上游串是 Fable（模型叫别的名字）也认；只给了 routeId 就只看那一条', () => {
    const opus = { id: 'opus-5.5', family: 'claude', displayName: 'Opus 5.5' };
    const subjects = {
      model: opus,
      routes: [
        { routeId: 'r-plain', subject: { ...opus, upstreamModel: 'claude-opus-5-5' } },
        { routeId: 'r-sneaky', subject: { ...opus, upstreamModel: 'claude-fable-5-1' } },
      ],
    };
    const engine = { label: '引擎', founderInCockpit: false };
    expect(() => guardFounderOnly(engine, subjects)).toThrow(ApiError);
    expect(() => guardFounderOnly(engine, subjects, 'r-sneaky')).toThrow(/引擎不行/);
    expect(() => guardFounderOnly(engine, subjects, 'r-plain')).not.toThrow();
    expect(() => guardFounderOnly({ label: '创始人', founderInCockpit: true }, subjects)).not.toThrow();
  });
});
