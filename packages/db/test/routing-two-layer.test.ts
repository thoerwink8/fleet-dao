// 路由两层（#574）：两张新表的约束（跑真迁移）、默认配置的读和校验、「活着吗」的存法。选路此刻仍读旧表，这里不测选路。
import { readFileSync } from 'node:fs';
import { routeEffortProblem } from '@fleet-dao/shared';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/catalog.ts';
import {
  loadRoutingConfig,
  parseRoutingConfig,
  ROUTING_DEFAULT_PATH,
  RoutingConfigError,
} from '../src/routing-config.ts';
import {
  type LivenessFact,
  layerLiveness,
  ROUTING_LIVENESS_SOURCES,
  type RoutingLiveness,
  routeLiveness,
} from '../src/routing-liveness.ts';
import { routingCatalog, routingPurposeModels } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRoute, catalog, expectViolation } from './helpers.ts';

describe('两张新表', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(async () => {
    await t.close();
  });
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

  it('两层都能写、能按顺序查出来', async () => {
    await t.db.insert(routingPurposeModels).values([
      { purpose: 'execute', modelId: 'opus-4.9', position: 0 },
      { purpose: 'execute', modelId: 'claude-fable-5.2', position: 1 },
    ]);
    await t.db.insert(routingCatalog).values([
      { modelId: 'opus-4.9', routeId: 'a-opus', position: 0, enabled: true },
      { modelId: 'opus-4.9', routeId: 'b-opus', position: 1, enabled: false },
    ]);
    const purposes = await t.db.select().from(routingPurposeModels).orderBy(routingPurposeModels.position);
    const models = await t.db.select().from(routingCatalog).orderBy(routingCatalog.position);
    expect(purposes.map((p) => p.modelId)).toEqual(['opus-4.9', 'claude-fable-5.2']);
    expect(models.map((m) => [m.routeId, m.enabled])).toEqual([
      ['a-opus', true],
      ['b-opus', false],
    ]);
  });

  it('【故意造出的失败】同一层同一个位置不许两行', async () => {
    await t.db
      .insert(routingCatalog)
      .values({ modelId: 'opus-4.9', routeId: 'a-opus', position: 0, enabled: true });
    await expectViolation(
      t.db
        .insert(routingCatalog)
        .values({ modelId: 'opus-4.9', routeId: 'b-opus', position: 0, enabled: true }),
      'routing_catalog_model_position_unique',
    );
    await t.db.insert(routingPurposeModels).values({ purpose: 'ui', modelId: 'opus-4.9', position: 0 });
    await expectViolation(
      t.db.insert(routingPurposeModels).values({ purpose: 'ui', modelId: 'claude-fable-5.2', position: 0 }),
      'routing_purpose_models_purpose_position_unique',
    );
  });

  it('【故意造出的失败】路由只能挂在它自己的模型下；位置不许是负数', async () => {
    await expectViolation(
      t.db
        .insert(routingCatalog)
        .values({ modelId: 'claude-fable-5.2', routeId: 'a-opus', position: 0, enabled: true }),
      'routing_catalog_route_of_model_fk',
    );
    await expectViolation(
      t.db
        .insert(routingCatalog)
        .values({ modelId: 'opus-4.9', routeId: 'a-opus', position: -1, enabled: true }),
      'routing_catalog_position_nonneg',
    );
  });

  it('【故意造出的失败】开关没有默认值：漏带 enabled 插不进去，不会悄悄全打开', async () => {
    const write = t.db
      .insert(routingCatalog)
      // @ts-expect-error 故意漏掉 enabled
      .values({ modelId: 'opus-4.9', routeId: 'a-opus', position: 0 });
    await expectViolation(write, 'enabled');
  });

  it('思考档位可空（没配）；【故意造出的失败】认不出的写法写不进去', async () => {
    await t.db.insert(routingCatalog).values([
      { modelId: 'opus-4.9', routeId: 'a-opus', position: 0, enabled: true },
      { modelId: 'opus-4.9', routeId: 'b-opus', position: 1, enabled: true, effort: 'max' },
    ]);
    const rows = await t.db.select().from(routingCatalog).orderBy(routingCatalog.position);
    expect(rows.map((r) => r.effort)).toEqual([null, 'max']);
    await expectViolation(
      t.db.insert(routingCatalog).values({
        modelId: 'claude-fable-5.2',
        routeId: 'a-fable',
        position: 0,
        enabled: true,
        // 故意写一个认不出的档位（类型上过不去，绕过类型直接看库里的约束拦不拦）
        effort: 'turbo' as never,
      }),
      'routing_catalog_effort_known',
    );
  });
});

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('默认配置 routing.default.json', () => {
  it('读得进来，用途和模型都有', async () => {
    const cfg = await loadRoutingConfig();
    expect(Object.keys(cfg.purposes)).toContain('default');
    expect(cfg.models['opus-5.5']?.map((r) => r.routeId)).toEqual([
      'claude-solo:opus-5.5:claude-code',
      'claude-carpool:opus-5.5:claude-code',
      'mirasim-relay:opus-5.5:mirasim',
    ]);
  });

  it('和目录配置样例对得上：每条路由在样例里有、且属于这个模型；样例里的路由都在骨架里（一条不漏）', async () => {
    const cfg = await loadRoutingConfig();
    const example = parseCatalog(repoFile('deploy/examples/catalog.example.json'), 'catalog.example.json');
    const inExample = new Map(example.routes.map((r) => [r.id, r.modelId]));
    const inSkeleton = new Map<string, string>();
    for (const [model, routes] of Object.entries(cfg.models)) {
      for (const r of routes) {
        expect(inExample.get(r.routeId), `${r.routeId} 在目录配置样例里没有`).toBe(model);
        inSkeleton.set(r.routeId, model);
      }
    }
    expect([...inExample.keys()].filter((id) => !inSkeleton.has(id))).toEqual([]);
  });

  it('界面用途里没有 GPT（照旧目录配置）、判断只用 Jev', async () => {
    const cfg = await loadRoutingConfig();
    expect(cfg.purposes.ui?.some((m) => m.startsWith('gpt'))).toBe(false);
    expect(cfg.purposes.judge).toEqual(['jev-1.13']);
  });

  it('【故意造出的失败】文件读不到：明确报错，不当成空配置', async () => {
    await expect(loadRoutingConfig(new URL('./不存在.json', ROUTING_DEFAULT_PATH))).rejects.toThrow(
      RoutingConfigError,
    );
  });

  it('【故意造出的失败】不是 JSON、格式认不出、引用对不上：都报错并写明哪里', () => {
    expect(() => parseRoutingConfig('{ 坏的')).toThrow(/不是合法的 JSON/);
    expect(() => parseRoutingConfig('{}')).toThrow(/格式不对/);
    expect(() =>
      parseRoutingConfig(JSON.stringify({ purposes: { 瞎写: ['m'] }, models: { m: [] } })),
    ).toThrow(/格式不对/);
    const one = { purposes: { default: ['m'] }, models: { m: [{ routeId: 'r', enabled: true }] } };
    expect(parseRoutingConfig(JSON.stringify(one)).purposes.default).toEqual(['m']);
    // 用途里的模型没有路由顺序
    expect(() => parseRoutingConfig(JSON.stringify({ ...one, purposes: { default: ['m', 'x'] } }))).toThrow(
      /模型 x 在 models 里没有路由顺序/,
    );
    // 同一层写重了、一条路由挂在两个模型下
    expect(() => parseRoutingConfig(JSON.stringify({ ...one, purposes: { default: ['m', 'm'] } }))).toThrow(
      /模型 m 写了不止一次/,
    );
    const twice = {
      purposes: { default: ['m', 'n'] },
      models: { m: [{ routeId: 'r', enabled: true }], n: [{ routeId: 'r', enabled: true }] },
    };
    expect(() => parseRoutingConfig(JSON.stringify(twice))).toThrow(/一条路由只属于一个模型/);
  });

  it('开关不写不行（没有默认值）', () => {
    const bad = { purposes: { default: ['m'] }, models: { m: [{ routeId: 'r' }] } };
    expect(() => parseRoutingConfig(JSON.stringify(bad))).toThrow(/格式不对/);
  });

  it('每条路由可以写思考档位；不写就是没配', () => {
    const cfg = parseRoutingConfig(
      JSON.stringify({
        purposes: { default: ['m'] },
        models: {
          m: [
            { routeId: 'r1', enabled: true, effort: 'medium' },
            { routeId: 'r2', enabled: true },
          ],
        },
      }),
    );
    expect(cfg.models.m?.map((r) => r.effort)).toEqual(['medium', undefined]);
  });

  it('【故意造出的失败】思考档位写了认不出的值：格式不对，写明哪条、只有哪几档', () => {
    const bad = {
      purposes: { default: ['m'] },
      models: { m: [{ routeId: 'r', enabled: true, effort: 'turbo' }] },
    };
    const err = (() => {
      try {
        parseRoutingConfig(JSON.stringify(bad));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect((err as RoutingConfigError).problems).toEqual([
      'models.m.0.effort：思考档位只有 low / medium / high / xhigh / max',
    ]);
  });

  it('仓里骨架写了的思考档位，这条路由的执行方式都认（按目录配置样例里的执行方式、上游模型串判）', async () => {
    const cfg = await loadRoutingConfig();
    const example = parseCatalog(repoFile('deploy/examples/catalog.example.json'), 'catalog.example.json');
    const byId = new Map(example.routes.map((r) => [r.id, r]));
    const problems: string[] = [];
    for (const routes of Object.values(cfg.models)) {
      for (const r of routes) {
        const route = byId.get(r.routeId);
        if (!route || r.effort === undefined) continue;
        const problem = routeEffortProblem(route.hostId, route.upstreamModel ?? route.modelId, r.effort);
        if (problem) problems.push(`${r.routeId}：${problem}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('「活着吗」的存法', () => {
  const fact = (verdict: LivenessFact['verdict']): LivenessFact => ({ verdict, reason: verdict });
  const live = (
    c: LivenessFact['verdict'],
    q: LivenessFact['verdict'],
    b: LivenessFact['verdict'],
  ): RoutingLiveness => ({
    connect: fact(c),
    quota: fact(q),
    ban: fact(b),
  });

  it('三件事来源写的列都真的在表里（改了列名这里会红）', () => {
    for (const [what, { table, columns }] of Object.entries(ROUTING_LIVENESS_SOURCES)) {
      const real = Object.keys(getTableColumns(table));
      for (const c of columns) expect(real, `${what}：表里没有列 ${c}`).toContain(c);
    }
  });

  it('一条路由：三件都 live 才 live；有 dead 就 dead；没 dead 有 unknown 就 unknown', () => {
    expect(routeLiveness(live('live', 'live', 'live'))).toBe('live');
    expect(routeLiveness(live('live', 'dead', 'live'))).toBe('dead');
    expect(routeLiveness(live('unknown', 'live', 'live'))).toBe('unknown');
    expect(routeLiveness(live('unknown', 'dead', 'live'))).toBe('dead');
  });

  it('【故意造出的失败】一层：没查成不当 live；空的一层是 dead，不是 live', () => {
    expect(layerLiveness(['dead', 'live'])).toBe('live');
    expect(layerLiveness(['dead', 'unknown'])).toBe('unknown');
    expect(layerLiveness(['unknown'])).not.toBe('live');
    expect(layerLiveness(['dead', 'dead'])).toBe('dead');
    expect(layerLiveness([])).toBe('dead');
  });
});
