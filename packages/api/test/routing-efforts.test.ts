// 驾驶舱「思考档位」页的接口（#470）：读每个模型下每条路由配的档位、改一条。真库上读写路由两层那张表（routing_catalog.effort）；
// 改了引擎起会话现读到的就是新的（routeLaunchFacts）；写错值、这家不认、没挂、别人刚改过都拒，库里不动、不记操作记录；
// 没接上（内存版）读写 unavailable、改回 503，不拿空列表冒充「都没配」。
import { auditLog, routeLaunchFacts, routingCatalog } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { RoutingEffortsResponse, UpdateRouteEffortResponse } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgRoutingEfforts, type RoutingEffortsPort } from '../src/routing-efforts.ts';
import { errorCode, type Harness, harness, pgHarness, T0, write } from './harness.ts';

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

/** 样例数据（dev-fixtures）里的路由挂进路由两层：Opus 一条 Claude Code、GPT 一条（Codex，引擎没接上）、Kimi 一条 Mirasim。 */
async function hang() {
  await t.db.insert(routingCatalog).values([
    { modelId: 'opus-5.5', routeId: 'rt-claude-opus', position: 0, enabled: true },
    { modelId: 'gpt-5.6', routeId: 'rt-mirasim-gpt', position: 0, enabled: true },
    { modelId: 'kimi-k3', routeId: 'rt-mirasim-kimi', position: 0, enabled: false },
  ]);
}

async function efforts(h: Pick<Harness, 'cockpit'>, cookie: string) {
  const res = await h.cockpit.request('/api/routing/efforts', { headers: { cookie } });
  expect(res.status).toBe(200);
  return RoutingEffortsResponse.parse(await res.json());
}

const put = (
  h: Pick<Harness, 'cockpit'>,
  s: { cookie: string; csrf: string },
  route: string,
  body: unknown,
) => h.cockpit.request(`/api/routing/efforts/${route}`, write('PUT', s, body));

const audits = async () =>
  (await t.db.select().from(auditLog)).filter((a) => a.action === 'routing.effort.update');

describe('驾驶舱思考档位：读', () => {
  it('接上了：每个模型下每条路由一行，带能配哪几档；没配的不给 effort，没配用 high；配不了的写为什么', async () => {
    current = await pgHarness(t, { routingEfforts: pgRoutingEfforts(t.db, () => T0) });
    await hang();
    const { cookie } = await current.login();
    const body = await efforts(current, cookie);
    expect(body.unavailable).toBeUndefined();
    expect(body.defaultEffort).toBe('high');
    expect(body.models.map((m) => [m.modelId, m.displayName, m.routes.map((r) => r.routeId)])).toEqual([
      ['gpt-5.6', 'GPT 5.6', ['rt-mirasim-gpt']],
      ['kimi-k3', 'Kimi k3', ['rt-mirasim-kimi']],
      ['opus-5.5', 'Opus 5.5', ['rt-claude-opus']],
    ]);
    const opus = body.models.find((m) => m.modelId === 'opus-5.5')?.routes[0];
    expect(opus).toEqual({
      routeId: 'rt-claude-opus',
      channelId: 'ch-claude',
      channelName: 'Claude 订阅',
      poolId: 'pool-claude-a',
      hostId: 'claude-code',
      model: 'opus-5.5',
      enabled: true,
      choices: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    // 关着的路由照样列出来，也能先配
    expect(body.models.find((m) => m.modelId === 'kimi-k3')?.routes[0]).toMatchObject({ enabled: false });
    // Codex 引擎没接上：配不了，写明为什么
    expect(body.models.find((m) => m.modelId === 'gpt-5.6')?.routes[0]).toMatchObject({
      choices: [],
      fixed: '引擎还没接上，起不了会话',
    });
  });

  it('【故意造出的失败】读不到库：回 503 写明没读成，不回空列表', async () => {
    const broken: RoutingEffortsPort = {
      read: async () => {
        throw new Error('column "effort" does not exist');
      },
      set: async () => {
        throw new Error('不该走到这');
      },
    };
    current = await pgHarness(t, { routingEfforts: broken });
    const { cookie } = await current.login();
    const res = await current.cockpit.request('/api/routing/efforts', { headers: { cookie } });
    expect(res.status).toBe(503);
    expect(await errorCode(res.clone())).toBe('routing_efforts_unreadable');
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'column "effort" does not exist',
    );
    expect(current.logs.some((l) => l.level === 'error' && l.message === '思考档位没读成')).toBe(true);
  });

  it('【故意造出的失败】没接上（开发环境、内存版）：读写 unavailable，改回 503，都不冒充「都没配」', async () => {
    const h = harness();
    const s = await h.login();
    const body = await efforts(h, s.cookie);
    expect(body.models).toEqual([]);
    expect(body.unavailable).toMatch(/^思考档位没接上：/);
    const res = await put(h, s, 'opus-5.5/rt-claude-opus', { effort: 'medium', expected: null });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('routing_efforts_not_wired');
  });

  it('没登录不给看、不给改', async () => {
    const h = harness();
    expect((await h.cockpit.request('/api/routing/efforts')).status).toBe(401);
    const res = await h.cockpit.request('/api/routing/efforts/opus-5.5/rt-claude-opus', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'medium', expected: null }),
    });
    expect(res.status).toBe(401);
  });
});

describe('驾驶舱思考档位：改', () => {
  it('改了直接写库、记操作记录；引擎起会话现读到的就是新档位；清掉回到没配', async () => {
    current = await pgHarness(t, { routingEfforts: pgRoutingEfforts(t.db, () => T0) });
    await hang();
    const s = await current.login();

    const res = await put(current, s, 'opus-5.5/rt-claude-opus', {
      effort: 'xhigh',
      expected: null,
      reason: '这周难活多',
    });
    expect(res.status).toBe(200);
    expect(UpdateRouteEffortResponse.parse(await res.json())).toEqual({
      modelId: 'opus-5.5',
      routeId: 'rt-claude-opus',
      effort: 'xhigh',
    });
    // 引擎下一个起的会话照这一份（segment-spawner 的 routeLaunchFacts）
    expect((await routeLaunchFacts(t.db, 'rt-claude-opus'))?.effort).toBe('xhigh');
    expect(
      (await efforts(current, s.cookie)).models.find((m) => m.modelId === 'opus-5.5')?.routes[0]?.effort,
    ).toBe('xhigh');
    expect(await audits()).toEqual([
      expect.objectContaining({
        actorKind: 'user',
        target: 'route:rt-claude-opus',
        before: { modelId: 'opus-5.5', effort: null },
        after: { modelId: 'opus-5.5', effort: 'xhigh' },
        reason: '这周难活多',
        via: 'cockpit',
        ok: true,
      }),
    ]);

    const cleared = await put(current, s, 'opus-5.5/rt-claude-opus', { effort: null, expected: 'xhigh' });
    expect(cleared.status).toBe(200);
    expect(UpdateRouteEffortResponse.parse(await cleared.json())).toEqual({
      modelId: 'opus-5.5',
      routeId: 'rt-claude-opus',
    });
    expect((await routeLaunchFacts(t.db, 'rt-claude-opus'))?.effort).toBeNull();
  });

  it('【故意造出的失败】写错值、这家不认、没挂进路由两层、别人刚改过：都拒，库里不动、不记操作记录', async () => {
    current = await pgHarness(t, { routingEfforts: pgRoutingEfforts(t.db, () => T0) });
    await hang();
    const s = await current.login();

    // 认不出的档：请求就不合约定
    const bad = await put(current, s, 'opus-5.5/rt-claude-opus', { effort: 'turbo', expected: null });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('invalid_request');

    // Codex 引擎没接上：这条路由配不了，说清为什么
    const fixed = await put(current, s, 'gpt-5.6/rt-mirasim-gpt', { effort: 'medium', expected: null });
    expect(fixed.status).toBe(422);
    expect(await errorCode(fixed.clone())).toBe('effort_not_allowed');
    expect(((await fixed.json()) as { error: { message: string } }).error.message).toBe(
      'codex 不支持单独传思考档位（effort）"medium"：引擎还没接上，起不了会话',
    );

    // 路由两层里没挂（模型对不上路由）
    const missing = await put(current, s, 'opus-5.5/rt-mirasim-kimi', { effort: 'low', expected: null });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('route_not_found');

    // 别人刚改过：带上现在的值，不覆盖
    await put(current, s, 'kimi-k3/rt-mirasim-kimi', { effort: 'medium', expected: null });
    const stale = await put(current, s, 'kimi-k3/rt-mirasim-kimi', { effort: 'low', expected: null });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { details: unknown } }).error.details).toEqual({
      current: 'medium',
    });

    const rows = Object.fromEntries(
      (await t.db.select().from(routingCatalog)).map((r) => [r.routeId, r.effort]),
    );
    expect(rows).toEqual({ 'rt-claude-opus': null, 'rt-mirasim-gpt': null, 'rt-mirasim-kimi': 'medium' });
    // 只有那一次真改成的记了
    expect((await audits()).map((a) => a.target)).toEqual(['route:rt-mirasim-kimi']);
  });

  it('【故意造出的失败】写不进库：回 503 写明原因，不当改成了', async () => {
    const broken: RoutingEffortsPort = {
      read: async () => [],
      set: async () => {
        throw new Error('connection terminated');
      },
    };
    current = await pgHarness(t, { routingEfforts: broken });
    const s = await current.login();
    const res = await put(current, s, 'opus-5.5/rt-claude-opus', { effort: 'low', expected: null });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('routing_effort_unwritable');
  });
});
