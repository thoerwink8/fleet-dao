// 路由两层的读法和装载（#574）：骨架写进库只补缺、引用对不上一行不写；读出来每一层写明活着吗、为什么；
// 「接得上、额度够、没被禁令挡」走选路同一份判法（evaluateRoutes），这里只验读成三件事、合成每层的结论。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyRoutingDefault } from '../src/routing-apply.ts';
import { parseRoutingConfig, RoutingConfigError } from '../src/routing-config.ts';
import { routingLayers } from '../src/routing-layers.ts';
import { STAGE_KINDS } from '../src/schema/enums.ts';
import { bans, routingCatalog, routingPurposeModels } from '../src/schema/index.ts';
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

  it('库里已有的不覆盖：驾驶舱改过的顺序、开关留着', async () => {
    await t.db
      .insert(routingCatalog)
      .values({ modelId: 'opus-4.9', routeId: 'b-opus', position: 0, enabled: false });
    const report = await applyRoutingDefault(t.db, config());
    expect(report.modelsKept).toEqual(['opus-4.9']);
    const rows = await t.db.select().from(routingCatalog);
    expect(rows.filter((r) => r.modelId === 'opus-4.9')).toEqual([
      { modelId: 'opus-4.9', routeId: 'b-opus', position: 0, enabled: false },
    ]);
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

  it('【故意造出的失败】没配的用途、没有路由的模型：整层 dead，problems 里写明，不当 live', async () => {
    await t.db.delete(routingPurposeModels);
    const none = await routingLayers(t.db, 'execute', { now: NOW });
    expect(none).toMatchObject({ verdict: 'dead', models: [] });
    expect(none.problems.join('')).toContain('用途 execute 没配模型顺序');

    await t.db.insert(routingPurposeModels).values({ purpose: 'execute', modelId: 'opus-4.9', position: 0 });
    await t.db.delete(routingCatalog);
    const empty = await routingLayers(t.db, 'execute', { now: NOW });
    expect(empty.models[0]?.verdict).toBe('dead');
    expect(empty.verdict).toBe('dead');
    expect(empty.problems.join('')).toContain('模型 opus-4.9 没有路由');
  });
});
