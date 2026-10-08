// 路由两层的读法和装载（#574）：骨架只在用途表还是空的时候整份写一次（#1356），引用对不上一行不写；读出来每一层写明活着吗、为什么；
// 「接得上、额度够、没被禁令挡」走选路同一份判法（evaluateRoutes），这里只验读成三件事、合成每层的结论。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveAlertWithReason } from '../src/queries/alerts.ts';
import { CARPOOL_CAP_ALERT } from '../src/queries/carpool-spend.ts';
import { upsertAlert } from '../src/queries/engine-alerts.ts';
import { applyRoutingDefault } from '../src/routing-apply.ts';
import { parseRoutingConfig, RoutingConfigError } from '../src/routing-config.ts';
import { routingLayers } from '../src/routing-layers.ts';
import { STAGE_KINDS } from '../src/schema/enums.ts';
import { bans, models, pools, routes, routingCatalog, routingPurposeModels } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRoute, addWindow, catalog, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await t.close();
});

const config = (over: Record<string, unknown> = {}) =>
  parseRoutingConfig(
    JSON.stringify({
      purposes: { default: ['opus-4.9'], ui: ['claude-fable-5.2', 'opus-4.9'] },
      models: {
        'opus-4.9': [
          { routeId: 'a-opus', enabled: true },
          { routeId: 'b-opus', enabled: true },
        ],
        'claude-fable-5.2': [{ routeId: 'a-fable', enabled: true }],
      },
      ...over,
    }),
  );

/** 额度读数新、有余：池读成了、窗口没用多少。 */
const freshQuota = async (poolId: string) =>
  addWindow(t.db, {
    poolId,
    window: '5h',
    utilization: 0.1,
    readAt: new Date(NOW.getTime() - MIN),
    reading: 'measured',
  });

describe('把默认骨架写进库', () => {
  beforeEach(async () => {
    await resetTestDb(t);
    await catalog(t.db);
    await addRoute(t.db, { id: 'a-opus', poolId: 'relay-a', modelId: 'opus-4.9' });
    await addRoute(t.db, { id: 'b-opus', poolId: 'relay-b', modelId: 'opus-4.9' });
    await addRoute(t.db, {
      id: 'a-fable',
      poolId: 'relay-a',
      modelId: 'claude-fable-5.2',
      hostId: 'mirasim',
    });
  });

  it('每个用途都写上（没单列的用 default），模型下按顺序写路由；再装一次什么都不动', async () => {
    const first = await applyRoutingDefault(t.db, config());
    expect(first.purposesApplied).toEqual([...STAGE_KINDS]);
    expect(first.modelsApplied.sort()).toEqual(['claude-fable-5.2', 'opus-4.9']);
    const purposes = await t.db.select().from(routingPurposeModels);
    expect(purposes.filter((p) => p.purpose === 'ui').map((p) => [p.modelId, p.position])).toEqual(
      expect.arrayContaining([
        ['claude-fable-5.2', 0],
        ['opus-4.9', 1],
      ]),
    );
    expect(purposes.filter((p) => p.purpose === 'execute').map((p) => p.modelId)).toEqual(['opus-4.9']);
    const again = await applyRoutingDefault(t.db, config());
    expect(again.purposesApplied).toEqual([]);
    expect(again.modelsApplied).toEqual([]);
    expect(again.purposesKept).toEqual([...STAGE_KINDS]);
    expect((await t.db.select().from(routingCatalog)).length).toBe(3);
  });

  it('用途还是空、模型已有路由行：不改那几行的开关和档位，也不追加；还没有路由行的模型仍按骨架写', async () => {
    await t.db
      .insert(routingCatalog)
      .values({ modelId: 'opus-4.9', routeId: 'b-opus', position: 0, enabled: false, effort: 'medium' });
    const withEffort = config({
      models: {
        'opus-4.9': [
          { routeId: 'a-opus', enabled: true, effort: 'max' },
          { routeId: 'b-opus', enabled: true, effort: 'xhigh' },
        ],
        'claude-fable-5.2': [{ routeId: 'a-fable', enabled: true }],
      },
    });
    const report = await applyRoutingDefault(t.db, withEffort);
    expect(report.modelsKept).toEqual(['opus-4.9']);
    expect(report.modelsApplied).toEqual(['claude-fable-5.2']);
    expect(report.routesAppended).toEqual([]);
    expect(report.purposesApplied).toEqual([...STAGE_KINDS]);
    const rows = await t.db.select().from(routingCatalog);
    expect(rows.filter((r) => r.modelId === 'opus-4.9').sort((a, b) => a.position - b.position)).toEqual([
      { modelId: 'opus-4.9', routeId: 'b-opus', position: 0, enabled: false, effort: 'medium' },
    ]);
  });

  it('模型已有路由行时不追加、不改开关；用途写完后再装一次一行不动', async () => {
    await t.db.insert(routingCatalog).values({
      modelId: 'opus-4.9',
      routeId: 'b-opus',
      position: 4,
      enabled: true,
      effort: null,
    });
    const cfg = config({
      models: {
        'opus-4.9': [
          { routeId: 'a-opus', enabled: false },
          { routeId: 'b-opus', enabled: false },
        ],
        'claude-fable-5.2': [{ routeId: 'a-fable', enabled: true }],
      },
    });
    const first = await applyRoutingDefault(t.db, cfg);
    expect(first.routesAppended).toEqual([]);
    const opus = (await t.db.select().from(routingCatalog))
      .filter((r) => r.modelId === 'opus-4.9')
      .sort((a, b) => a.position - b.position);
    expect(opus.map((r) => [r.routeId, r.position, r.enabled])).toEqual([['b-opus', 4, true]]);
    const beforePurpose = await t.db.select().from(routingPurposeModels);
    const beforeCatalog = await t.db.select().from(routingCatalog);
    const again = await applyRoutingDefault(t.db, cfg);
    expect(again.routesAppended).toEqual([]);
    expect(again.purposeModelsAppended).toEqual([]);
    expect(again.purposeRowsInserted).toBe(0);
    expect(again.catalogRowsInserted).toBe(0);
    expect(await t.db.select().from(routingPurposeModels)).toEqual(beforePurpose);
    expect(await t.db.select().from(routingCatalog)).toEqual(beforeCatalog);
  });

  it('用途已有任何一行：不再补模型、不再装没写过的用途、已有顺序留着', async () => {
    await t.db.insert(routingPurposeModels).values([
      { purpose: 'ui', modelId: 'opus-4.9', position: 0 },
      { purpose: 'ui', modelId: 'claude-fable-5.2', position: 7 },
    ]);
    await t.db.insert(models).values({ id: 'haiku-4.5', family: 'claude', displayName: 'Haiku 4.5' });
    await addRoute(t.db, { id: 'a-haiku', poolId: 'relay-a', modelId: 'haiku-4.5' });
    const cfg = config({
      purposes: {
        default: ['opus-4.9', 'haiku-4.5'],
        ui: ['claude-fable-5.2', 'opus-4.9', 'haiku-4.5'],
      },
      models: {
        'opus-4.9': [{ routeId: 'a-opus', enabled: true }],
        'claude-fable-5.2': [{ routeId: 'a-fable', enabled: true }],
        'haiku-4.5': [{ routeId: 'a-haiku', enabled: false }],
      },
    });
    const beforePurpose = await t.db.select().from(routingPurposeModels);
    const beforeCatalog = await t.db.select().from(routingCatalog);
    const report = await applyRoutingDefault(t.db, cfg);
    expect(report.purposeModelsAppended).toEqual([]);
    expect(report.routesAppended).toEqual([]);
    expect(report.purposesApplied).toEqual([]);
    expect(report.purposeRowsInserted).toBe(0);
    expect(report.catalogRowsInserted).toBe(0);
    expect(await t.db.select().from(routingPurposeModels)).toEqual(beforePurpose);
    expect(await t.db.select().from(routingCatalog)).toEqual(beforeCatalog);
  });

  it('【故意造出的失败】用途表已有任何一行就按行补缺（旧行为）：缺的路由、缺的模型都必须留在外面', async () => {
    await t.db
      .insert(routingCatalog)
      .values({ modelId: 'opus-4.9', routeId: 'a-opus', position: 0, enabled: true, effort: 'low' });
    await t.db.insert(routingPurposeModels).values({ purpose: 'execute', modelId: 'opus-4.9', position: 0 });
    const beforeCatalog = await t.db.select().from(routingCatalog);
    const beforePurpose = await t.db.select().from(routingPurposeModels);
    const report = await applyRoutingDefault(t.db, config());
    expect(report.catalogRowsInserted).toBe(0);
    expect(report.purposeRowsInserted).toBe(0);
    expect(await t.db.select().from(routingCatalog)).toEqual(beforeCatalog);
    expect(await t.db.select().from(routingPurposeModels)).toEqual(beforePurpose);
    expect(beforeCatalog.find((r) => r.routeId === 'b-opus')).toBeUndefined();
  });

  it('骨架里写的思考档位：模型第一次装进库时跟着写进去；没写的是空（起会话用 high）', async () => {
    const withEffort = config({
      models: {
        'opus-4.9': [
          { routeId: 'a-opus', enabled: true, effort: 'max' },
          { routeId: 'b-opus', enabled: true },
        ],
        'claude-fable-5.2': [{ routeId: 'a-fable', enabled: true, effort: 'low' }],
      },
    });
    await applyRoutingDefault(t.db, withEffort);
    const rows = await t.db.select().from(routingCatalog);
    expect(Object.fromEntries(rows.map((r) => [r.routeId, r.effort]))).toEqual({
      'a-opus': 'max',
      'b-opus': null,
      'a-fable': 'low',
    });
  });

  it('【故意造出的失败】骨架里的思考档位这条路由的执行方式不认：点名哪条、为什么，一行不写', async () => {
    await addRoute(t.db, {
      id: 'g-grok',
      poolId: 'relay-a',
      modelId: 'opus-4.9',
      hostId: 'grok',
      upstreamModel: 'grok-4.7',
    });
    const bad = config({
      models: {
        'opus-4.9': [
          { routeId: 'a-opus', enabled: true },
          { routeId: 'g-grok', enabled: true, effort: 'max' },
        ],
        'claude-fable-5.2': [{ routeId: 'a-fable', enabled: true }],
      },
    });
    const err = await applyRoutingDefault(t.db, bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect((err as RoutingConfigError).problems.join('\n')).toContain(
      '路由 g-grok 的思考档位配不了：grok 不支持思考档位（effort）max（只认 low / medium / high / xhigh）',
    );
    expect(await t.db.select().from(routingPurposeModels)).toEqual([]);
    expect(await t.db.select().from(routingCatalog)).toEqual([]);
  });

  it('【故意造出的失败】引用对不上：模型、路由库里没有、路由不属于那个模型；一行都不写', async () => {
    const bad = config({
      purposes: { default: ['opus-4.9', 'ghost-model'] },
      models: {
        'opus-4.9': [
          { routeId: 'a-opus', enabled: true },
          { routeId: 'a-fable', enabled: true },
          { routeId: 'nope', enabled: true },
        ],
        'ghost-model': [{ routeId: 'b-opus', enabled: true }],
      },
    });
    const err = await applyRoutingDefault(t.db, bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoutingConfigError);
    const problems = (err as RoutingConfigError).problems.join('\n');
    expect(problems).toContain('模型 ghost-model 库里没有');
    expect(problems).toContain('路由 nope 库里没有');
    expect(problems).toContain('路由 a-fable 在库里属于模型 claude-fable-5.2');
    expect(await t.db.select().from(routingPurposeModels)).toEqual([]);
    expect(await t.db.select().from(routingCatalog)).toEqual([]);
  });

  it('【故意造出的失败】没有 default、又有用途没单列：明确报错，不用空顺序顶', async () => {
    const partial = config({ purposes: { ui: ['opus-4.9'] } });
    await expect(applyRoutingDefault(t.db, partial)).rejects.toThrow(/没有 default，这些用途也没单列/);
    expect(await t.db.select().from(routingPurposeModels)).toEqual([]);
  });
});

describe('读成「用途 → 模型 → 路由」，每层写明活着吗', () => {
  beforeEach(async () => {
    await resetTestDb(t);
    await catalog(t.db);
    await addRoute(t.db, { id: 'a-opus', poolId: 'relay-a', modelId: 'opus-4.9' });
    await addRoute(t.db, { id: 'b-opus', poolId: 'relay-b', modelId: 'opus-4.9', alive: false });
    await addRoute(t.db, {
      id: 'a-fable',
      poolId: 'relay-a',
      modelId: 'claude-fable-5.2',
      hostId: 'mirasim',
    });
    await applyRoutingDefault(t.db, config());
  });

  it('额度读新、探针探通：路由 live，模型 live，用途 live；没探过的路由是 unknown，不是 dead', async () => {
    await freshQuota('relay-a');
    await freshQuota('relay-b');
    const layers = await routingLayers(t.db, 'execute', { now: NOW });
    expect(layers.verdict).toBe('live');
    const opus = layers.models.find((m) => m.modelId === 'opus-4.9');
    expect(opus?.verdict).toBe('live');
    const byRoute = Object.fromEntries((opus?.routes ?? []).map((r) => [r.candidate.routeId, r]));
    expect(byRoute['a-opus']?.verdict).toBe('live');
    // b-opus 没探过（alive=false、没有探针结论）：unknown，原因写探针还没看过
    expect(byRoute['b-opus']?.verdict).toBe('unknown');
    expect(byRoute['b-opus']?.liveness.connect.reason).toContain('探针还没看过');
  });

  it('探针没探、探了没通：原因照探针自己写的说（按量计费不探是不知道，不是挂着别的组织；没通是死）', async () => {
    await freshQuota('relay-b');
    const probe = (state: 'skipped' | 'failed' | 'not_wired', detail: string) =>
      t.db
        .update(routes)
        .set({ alive: false, probeState: state, probedAt: NOW, probeDetail: detail })
        .where(eq(routes.id, 'b-opus'));
    const bOpus = async () =>
      (await routingLayers(t.db, 'execute', { now: NOW })).models[0]?.routes.find(
        (r) => r.candidate.routeId === 'b-opus',
      )?.liveness.connect;

    await probe('skipped', '按量计费的渠道不自动探：探一次就多一笔账');
    expect(await bOpus()).toEqual({
      verdict: 'unknown',
      reason: '探针这一轮没探它（不是探了没通）：按量计费的渠道不自动探：探一次就多一笔账',
    });
    await probe('failed', '连探两次都没通：进程退出（退出码 1）');
    expect(await bOpus()).toEqual({
      verdict: 'dead',
      reason: '探针判不在线：连探两次都没通：进程退出（退出码 1）',
    });
    await probe('not_wired', '执行方式「Grok 命令行」的插头引擎还没接');
    expect(await bOpus()).toEqual({
      verdict: 'dead',
      reason: '探针判不在线：执行方式「Grok 命令行」的插头引擎还没接',
    });
  });

  it('额度没读成：路由 unknown，整层不当 live（不当「还够」）', async () => {
    const layers = await routingLayers(t.db, 'execute', { now: NOW });
    const a = layers.models[0]?.routes.find((r) => r.candidate.routeId === 'a-opus');
    expect(a?.liveness.quota.verdict).toBe('unknown');
    expect(a?.verdict).toBe('unknown');
    expect(layers.verdict).toBe('unknown');
  });

  it('用满了是 dead；开关关着、命中禁令都是 dead，原因写明', async () => {
    await freshQuota('relay-b');
    await addWindow(t.db, {
      poolId: 'relay-a',
      window: '5h',
      utilization: 1,
      readAt: new Date(NOW.getTime() - MIN),
      reading: 'measured',
    });
    await t.db.insert(bans).values({ modelId: 'claude-fable-5.2', reason: '不用这个模型' });
    const layers = await routingLayers(t.db, 'ui', { now: NOW });
    const fable = layers.models.find((m) => m.modelId === 'claude-fable-5.2');
    expect(fable?.verdict).toBe('dead');
    expect(fable?.routes[0]?.liveness.ban.reason).toContain('不用这个模型');
    const opusA = layers.models
      .find((m) => m.modelId === 'opus-4.9')
      ?.routes.find((r) => r.candidate.routeId === 'a-opus');
    expect(opusA?.liveness.quota).toMatchObject({ verdict: 'dead' });
    await t.db.delete(bans); // 禁令优先写在原因里，要看开关就先撤掉它
    await t.db.update(routingCatalog).set({ enabled: false });
    const off = await routingLayers(t.db, 'ui', { now: NOW });
    // fable 还被代码里的硬禁令挡着（不用 Fable），原因先写禁令；opus 的原因是开关关着
    const offOpus = off.models.find((m) => m.modelId === 'opus-4.9');
    expect(offOpus?.routes.every((r) => r.liveness.ban.reason.includes('关着'))).toBe(true);
    expect(offOpus?.verdict).toBe('dead');
  });

  describe('拼车并发登记核对不上（carpool-cap:registry 提醒开着）：拼车池的路由在驾驶舱上写明不派（#896）', () => {
    const capAlert = async (resolved: boolean) => {
      await upsertAlert(t.db, {
        dedupeKey: CARPOOL_CAP_ALERT,
        level: 'alert',
        taskId: null,
        title: '法国的拼车并发上限和登记的对不上',
        body: '登记 2，库里 4',
      });
      if (resolved) {
        await resolveAlertWithReason(t.db, { dedupeKey: CARPOOL_CAP_ALERT, by: 'test', why: '对上了' });
      }
    };
    /** relay-a 当拼车池（带组织类型 carpool）；relay-b 是普通池。 */
    const withCarpool = async () => {
      await t.db
        .update(pools)
        .set({ orgKind: 'carpool', runAsUser: 'fleet-agent-carpool' })
        .where(eq(pools.id, 'relay-a'));
      await freshQuota('relay-a');
      await freshQuota('relay-b');
    };
    const banOf = async (routeId: string) => {
      const layers = await routingLayers(t.db, 'execute', { now: NOW });
      const route = layers.models.flatMap((m) => m.routes).find((r) => r.candidate.routeId === routeId);
      return { verdict: route?.verdict, ban: route?.liveness.ban };
    };

    it('提醒开着：拼车池的路由「禁令与开关」那一件是 dead、写明原因；别的池不受影响', async () => {
      await withCarpool();
      await capAlert(false);
      const carpool = await banOf('a-opus');
      expect(carpool.verdict).toBe('dead');
      expect(carpool.ban?.verdict).toBe('dead');
      expect(carpool.ban?.reason).toContain('引擎暂不往拼车池派新活');
      expect(carpool.ban?.reason).toContain('拼车并发登记核对不上');
      expect(await banOf('b-opus')).toMatchObject({ ban: { verdict: 'live' } });
    });

    it('提醒撤了（对上了）、或从来没推过：恢复', async () => {
      await withCarpool();
      expect((await banOf('a-opus')).ban?.verdict).toBe('live');
      await capAlert(true);
      expect((await banOf('a-opus')).ban?.verdict).toBe('live');
    });

    it('原来就被禁令、开关挡着的，原因照旧写禁令、开关（不被登记那一条盖掉）', async () => {
      await withCarpool();
      await capAlert(false);
      await t.db.update(routingCatalog).set({ enabled: false }).where(eq(routingCatalog.routeId, 'a-opus'));
      expect((await banOf('a-opus')).ban?.reason).toContain('开关关着');
    });

    it('【故意造出的失败】提醒读不了（notifications 表挪开）：照常抛，不当成没事', async () => {
      await withCarpool();
      await t.client.exec('alter table notifications rename to notifications_unreadable');
      try {
        await expect(routingLayers(t.db, 'execute', { now: NOW })).rejects.toThrow();
      } finally {
        await t.client.exec('alter table notifications_unreadable rename to notifications');
      }
    });
  });

  it('【故意造出的失败】没配的用途、没有路由的模型：整层 dead，problems 里写明，不当 live', async () => {
    await t.db.delete(routingPurposeModels);
    const none = await routingLayers(t.db, 'execute', { now: NOW });
    expect(none).toMatchObject({ verdict: 'dead', models: [] });
    expect(none.problems).toEqual(['这个用途没有模型，派不了']);

    await t.db.insert(routingPurposeModels).values({ purpose: 'execute', modelId: 'opus-4.9', position: 0 });
    await t.db.delete(routingCatalog);
    const empty = await routingLayers(t.db, 'execute', { now: NOW });
    expect(empty.models[0]?.verdict).toBe('dead');
    expect(empty.verdict).toBe('dead');
    expect(empty.problems.join('')).toContain('模型 opus-4.9 没有路由');
  });
});
