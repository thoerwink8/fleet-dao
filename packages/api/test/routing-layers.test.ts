// 驾驶舱「路由」页的接口（#574）：路由两层每一层现在活着吗。真库上按路由两层那两张表 + 探针、额度、禁令现算；
// 没接上（内存版）写 unavailable，读不到回 503 写明没读成——都不回空列表冒充「都没配」。
import {
  clearReservations,
  poolReservations,
  pools,
  quotaWindows,
  reservePoolSlot,
  routingCatalog,
  routingPurposeModels,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { poolFull, RoutingLayersResponse, type StageKind } from '@fleet-dao/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgRoutingLayers, type RoutingLayersPort } from '../src/routing-layers.ts';
import { errorCode, type Harness, harness, pgHarness, T0 } from './harness.ts';

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

async function layers(h: Pick<Harness, 'cockpit'>, cookie: string) {
  const res = await h.cockpit.request('/api/routing/layers', { headers: { cookie } });
  expect(res.status).toBe(200);
  return RoutingLayersResponse.parse(await res.json());
}

/** 用途 → 模型顺序；模型 → 路由顺序（样例数据 dev-fixtures 里的路由）。 */
async function setLayers(
  purposes: Partial<Record<StageKind, string[]>>,
  models: Record<string, { routeId: string; enabled: boolean }[]>,
) {
  for (const [purpose, ids] of Object.entries(purposes) as [StageKind, string[]][]) {
    await t.db
      .insert(routingPurposeModels)
      .values(ids.map((modelId, position) => ({ purpose, modelId, position })));
  }
  for (const [modelId, routes] of Object.entries(models)) {
    if (routes.length === 0) continue;
    await t.db
      .insert(routingCatalog)
      .values(routes.map((r, position) => ({ modelId, routeId: r.routeId, position, enabled: r.enabled })));
  }
}

const SAMPLE_MODELS = {
  'opus-5.5': [{ routeId: 'rt-claude-opus', enabled: true }],
  'kimi-k3': [{ routeId: 'rt-mirasim-kimi', enabled: true }],
  'gpt-5.6': [{ routeId: 'rt-mirasim-gpt', enabled: true }],
};

describe('驾驶舱路由页：路由两层每一层现在活着吗', () => {
  it('接上了：每个用途按 StageKind 的先后各一份，模型、路由按两层的先后，名字从目录里查，原因照写', async () => {
    current = await pgHarness(t, { routingLayers: pgRoutingLayers(t.db) });
    await setLayers(
      {
        execute: ['opus-5.5', 'kimi-k3'],
        ui: ['kimi-k3', 'opus-5.5'],
        review: ['gpt-5.6'],
        plan: ['fable-5.1'],
      },
      SAMPLE_MODELS,
    );
    const { cookie } = await current.login();
    const body = await layers(current, cookie);

    expect(body.unavailable).toBeUndefined();
    expect(body.asOf).toBe(T0.toISOString());
    expect(body.purposes.map((p) => p.purpose)).toEqual([
      'triage',
      'spec',
      'plan',
      'execute',
      'ui',
      'review',
      'verify',
      'research',
      'judge',
    ]);
    const by = new Map(body.purposes.map((p) => [p.purpose, p]));

    // 写码：Opus 那条三件事都过 → 活；名字是目录里的，不是编号
    const execute = by.get('execute');
    expect(execute?.verdict).toBe('live');
    expect(execute?.problems).toEqual([]);
    expect(execute?.models.map((m) => [m.displayName, m.verdict])).toEqual([
      ['Opus 5.5', 'live'],
      // 中转池一次都没读成额度：不知道，不当「还够」
      ['Kimi k3', 'unknown'],
    ]);
    const opus = execute?.models[0]?.routes[0];
    expect(opus).toMatchObject({
      routeId: 'rt-claude-opus',
      channelName: 'Claude 订阅',
      poolId: 'pool-claude-a',
      hostId: 'claude-code',
      enabled: true,
      verdict: 'live',
      connect: { verdict: 'live' },
      quota: { verdict: 'live' },
      ban: { verdict: 'live' },
      exhausted: [],
    });
    expect(opus?.probedAt).toBe(new Date(T0.getTime() - 4 * 60_000).toISOString());
    expect(execute?.models[1]?.routes[0]?.quota).toEqual({
      verdict: 'unknown',
      reason: '额度没读成、读数过期，或判不了扣不扣这条路由',
    });

    // UI：排第一的 Kimi 被库里的禁令挡了 → 死，原因写禁令原话；Opus 还活着，整层照样活
    const ui = by.get('ui');
    expect(ui?.verdict).toBe('live');
    expect(ui?.models.map((m) => [m.modelId, m.verdict])).toEqual([
      ['kimi-k3', 'dead'],
      ['opus-5.5', 'live'],
    ]);
    expect(ui?.models[0]?.routes[0]?.ban).toEqual({
      verdict: 'dead',
      reason: '命中禁令：（样例）库里另配的禁令：Kimi 暂不进 UI',
    });

    // 第二意见：唯一一条路额度不知道 → 整层不知道
    expect(by.get('review')?.verdict).toBe('unknown');

    // 方案：排进去的模型下一条路由都没有 → 死，缺口照写；名字、族从目录里查
    const plan = by.get('plan');
    expect(plan?.verdict).toBe('dead');
    expect(plan?.problems).toEqual(['模型 fable-5.1 没有路由（routing_catalog 里一条都没有）']);
    expect(plan?.models).toEqual([
      { modelId: 'fable-5.1', displayName: 'Fable 5.1', family: 'claude', verdict: 'dead', routes: [] },
    ]);

    // 没配的用途：死，写明没配，不给空的当「没有」
    expect(by.get('triage')).toEqual({
      purpose: 'triage',
      verdict: 'dead',
      problems: ['用途 triage 没配模型顺序'],
      models: [],
    });
  });

  it('额度用满：额度那一件死，写明哪个窗、几点清零；开关关着的照样列出来，写「开关关着」', async () => {
    current = await pgHarness(t, { routingLayers: pgRoutingLayers(t.db) });
    await setLayers(
      { execute: ['opus-5.5', 'kimi-k3'] },
      { ...SAMPLE_MODELS, 'kimi-k3': [{ routeId: 'rt-mirasim-kimi', enabled: false }] },
    );
    await t.db
      .update(quotaWindows)
      .set({ utilization: 1 })
      .where(and(eq(quotaWindows.poolId, 'pool-claude-a'), eq(quotaWindows.label, '5h')));
    const { cookie } = await current.login();
    const execute = (await layers(current, cookie)).purposes.find((p) => p.purpose === 'execute');

    const opus = execute?.models[0]?.routes[0];
    expect(opus?.verdict).toBe('dead');
    expect(opus?.quota).toEqual({ verdict: 'dead', reason: '适用的额度窗用满了' });
    expect(opus?.exhausted).toEqual([
      { label: '5h', resetsAt: new Date(T0.getTime() + 120 * 60_000).toISOString() },
    ]);
    const kimi = execute?.models[1]?.routes[0];
    expect(kimi).toMatchObject({
      enabled: false,
      verdict: 'dead',
      ban: { verdict: 'dead', reason: '开关关着（这条路由在它的模型下关着）' },
    });
    // 两个模型都死：整个用途死
    expect(execute?.verdict).toBe('dead');
  });

  it('已选定还没开跑的预占也带出来（#800）：池上限 = 在跑 + 2，两个预占 → 接口给 inFlight、reserved、max，满不满由两者之和判；过期的预占不算、清掉后不再算', async () => {
    current = await pgHarness(t, { routingLayers: pgRoutingLayers(t.db) });
    await setLayers({ execute: ['opus-5.5'] }, { 'opus-5.5': SAMPLE_MODELS['opus-5.5'] });
    const { cookie } = await current.login();
    const route = async () =>
      (await layers(current as Harness, cookie)).purposes
        .find((p) => p.purpose === 'execute')
        ?.models[0]?.routes.find((r) => r.routeId === 'rt-claude-opus');
    const before = await route();
    const running = before?.inFlight ?? Number.NaN;
    expect(before?.reserved).toBe(0);
    // 上限 = 在跑的 + 2：只看在跑数就是「有空位」，两个预占占满后就是满
    await t.db
      .update(pools)
      .set({ maxConcurrency: running + 2 })
      .where(eq(pools.id, 'pool-claude-a'));
    const [task] = await t.db.select({ id: tasks.id }).from(tasks).limit(1);
    if (!task) throw new Error('夹具里没有单');
    const reserve = (segment: 'manual' | 'verify', over: { expiresAt?: Date } = {}) =>
      reservePoolSlot(t.db, {
        taskId: task.id,
        segment,
        routeId: 'rt-claude-opus',
        reservedAt: T0,
        expiresAt: new Date(T0.getTime() + 20 * 60_000),
        ...over,
      });
    expect(await reserve('manual')).toMatchObject({ reserved: true });
    expect(await reserve('verify')).toMatchObject({ reserved: true });
    const full = await route();
    expect(full).toMatchObject({ inFlight: running, reserved: 2, maxConcurrency: running + 2 });
    expect(poolFull(full as NonNullable<typeof full>)).toBe(true);
    // 预占过了期：不算
    await t.db
      .update(poolReservations)
      .set({
        reservedAt: new Date(T0.getTime() - 40 * 60_000),
        expiresAt: new Date(T0.getTime() - 20 * 60_000),
      });
    const lapsed = await route();
    expect(lapsed).toMatchObject({ inFlight: running, reserved: 0 });
    expect(poolFull(lapsed as NonNullable<typeof lapsed>)).toBe(false);
    // 引擎重启清掉预占：不再算
    await reserve('manual');
    expect((await route())?.reserved).toBe(1);
    await clearReservations(t.db);
    expect((await route())?.reserved).toBe(0);
  });

  it('【故意造出的失败】库里还没有路由两层那两张表（或读不到库）：回 503 写明没读成，不回空列表', async () => {
    const broken: RoutingLayersPort = {
      read: async () => {
        throw new Error('relation "routing_purpose_models" does not exist');
      },
    };
    current = await pgHarness(t, { routingLayers: broken });
    const { cookie } = await current.login();
    const res = await current.cockpit.request('/api/routing/layers', { headers: { cookie } });
    expect(res.status).toBe(503);
    expect(await errorCode(res.clone())).toBe('routing_layers_unreadable');
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('relation "routing_purpose_models" does not exist');
    expect(current.logs.some((l) => l.level === 'error' && l.message === '路由两层没读成')).toBe(true);
  });

  it('【故意造出的失败】没接上（开发环境、内存版）：写 unavailable 说为什么，不给空列表冒充「都没配」', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const body = await layers(h, cookie);
    expect(body.purposes).toEqual([]);
    expect(body.unavailable).toMatch(/^路由两层没接上：/);
  });

  it('没登录不给看', async () => {
    const h = harness();
    const res = await h.cockpit.request('/api/routing/layers');
    expect(res.status).toBe(401);
  });
});
