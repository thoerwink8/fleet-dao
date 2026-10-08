// 路由两层（#574）：两张新表的约束（跑真迁移）、默认配置的读和校验、「活着吗」的存法。选路此刻仍读旧表，这里不测选路。
import { readFileSync } from 'node:fs';
import { hardBanFor, routeEffortProblem } from '@fleet-dao/shared';
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
      // 2026-10-08 按 Cursor 订阅清单补的一条，关着、不进用途
      'cursor:opus-5.5:cursor-agent',
    ]);
  });

  // 骨架引用了、目录配置里没有的模型和路由：发版装载器会拒装（法国库的目录配置是人加的，样例先加、法国后加，骨架要等法国有了才能引用）。
  // 样例比骨架多是允许的（样例里的新模型可以先躺着），骨架比样例多不行。
  const skeletonProblems = (
    cfg: Awaited<ReturnType<typeof loadRoutingConfig>>,
    example: ReturnType<typeof parseCatalog>,
  ) => {
    const modelsInExample = new Set(example.models.map((m) => m.id));
    const routeModel = new Map(example.routes.map((r) => [r.id, r.modelId]));
    const problems: string[] = [];
    for (const [purpose, ids] of Object.entries(cfg.purposes)) {
      for (const id of ids ?? []) {
        if (!modelsInExample.has(id)) problems.push(`用途 ${purpose} 引用的模型 ${id} 在目录配置里没有`);
      }
    }
    for (const [model, routes] of Object.entries(cfg.models)) {
      if (!modelsInExample.has(model)) problems.push(`模型 ${model} 在目录配置里没有`);
      for (const r of routes) {
        const owner = routeModel.get(r.routeId);
        if (owner === undefined) problems.push(`路由 ${r.routeId} 在目录配置里没有`);
        else if (owner !== model)
          problems.push(`路由 ${r.routeId} 在目录配置里属于 ${owner}，骨架挂在 ${model} 下`);
      }
    }
    return problems;
  };

  it('骨架引用的每个模型和路由，目录配置样例里都有、且路由属于这个模型', async () => {
    const cfg = await loadRoutingConfig();
    const example = parseCatalog(repoFile('deploy/catalog.json'), 'deploy/catalog.json');
    expect(skeletonProblems(cfg, example)).toEqual([]);
  });

  it('【故意造出的失败】骨架引用了目录配置里没有的模型或路由：报出来（发版被这个挡过）', async () => {
    const example = parseCatalog(repoFile('deploy/catalog.json'), 'deploy/catalog.json');
    const cfg = parseRoutingConfig(
      JSON.stringify({
        purposes: { default: ['grok-4.7', 'not-in-catalog'] },
        models: {
          'grok-4.7': [
            { routeId: 'grok:grok-4.7:grok', enabled: true },
            { routeId: 'grok:no-such-route:grok', enabled: true },
          ],
          'not-in-catalog': [{ routeId: 'x:not-in-catalog:y', enabled: true }],
        },
      }),
    );
    expect(skeletonProblems(cfg, example)).toEqual([
      '用途 default 引用的模型 not-in-catalog 在目录配置里没有',
      '路由 grok:no-such-route:grok 在目录配置里没有',
      '模型 not-in-catalog 在目录配置里没有',
      '路由 x:not-in-catalog:y 在目录配置里没有',
    ]);
  });

  it('创始人 2026-10-06 定的角色：lead 类（default 兜底）Sonnet 5.5 第一、execute 和 ui 仍是 Grok 第一、verify 仍是 GPT luna 第一；GLM 排在写码、验证、界面、兜底的末尾，判断里没有', async () => {
    const cfg = await loadRoutingConfig();
    for (const stage of ['default', 'triage', 'spec', 'plan', 'review', 'research'] as const) {
      expect((cfg.purposes[stage] ?? cfg.purposes.default)?.[0], stage).toBe('sonnet-5.5');
    }
    expect(cfg.purposes.execute?.[0]).toBe('grok-4.7');
    expect(cfg.purposes.ui?.[0]).toBe('grok-4.7');
    // 创始人 2026-10-07 睡前：reviewer 默认 gpt-6-sol（走 mirasim）；luna 退到第二
    expect(cfg.purposes.verify?.slice(0, 2)).toEqual(['gpt-6-sol', 'gpt-5.6-luna']);
    for (const stage of ['default', 'verify', 'execute', 'ui'] as const) {
      expect(cfg.purposes[stage]?.at(-1), stage).toBe('glm-5.3-flash');
    }
    expect(cfg.purposes.judge).not.toContain('glm-5.3-flash');
    expect(cfg.models['sonnet-5.5']?.map((r) => [r.routeId, r.enabled])).toEqual([
      ['claude-solo:sonnet-5.5:claude-code', true],
      ['claude-carpool:sonnet-5.5:claude-code', true],
      ['mirasim-relay:sonnet-5.5:mirasim', false],
      ['cursor:sonnet-5.5:cursor-agent', false],
    ]);
    expect(cfg.models['glm-5.3-flash']?.map((r) => [r.routeId, r.enabled])).toEqual([
      ['mirasim-relay:glm-5.3-flash:mirasim', true],
    ]);
  });

  it('整理待办（groom，#1338、#1351）：默认顺序 Haiku 5.5 第一（创始人 2026-10-08：省钱+快），Sonnet 5.5、Opus 5.5 紧跟，后面是其余模型，没有 Fable、没有 Jev；引用的模型都在骨架的 models 里', async () => {
    const cfg = await loadRoutingConfig();
    const groom = cfg.purposes.groom ?? [];
    expect(groom.slice(0, 3)).toEqual(['haiku-5.5', 'sonnet-5.5', 'opus-5.5']);
    expect(groom.length).toBeGreaterThan(3);
    expect(groom.some((m) => /fable/i.test(m))).toBe(false);
    expect(groom).not.toContain('jev-1.13');
    for (const m of groom) expect(Object.keys(cfg.models), m).toContain(m);
  });

  it('Haiku 5.5（#1351）：骨架里路由顺序 solo → carpool → cursor、只有 solo 开着；只进 groom；目录里两条 claude-code 路由点名 claude-haiku-5-5', async () => {
    const cfg = await loadRoutingConfig();
    expect(cfg.models['haiku-5.5']?.map((r) => [r.routeId, r.enabled])).toEqual([
      ['claude-solo:haiku-5.5:claude-code', true],
      ['claude-carpool:haiku-5.5:claude-code', false],
      ['cursor:haiku-5.5:cursor-agent', false],
    ]);
    const usedIn = Object.entries(cfg.purposes)
      .filter(([, order]) => order.includes('haiku-5.5'))
      .map(([purpose]) => purpose);
    expect(usedIn).toEqual(['groom']);
    const example = parseCatalog(repoFile('deploy/catalog.json'), 'deploy/catalog.json');
    for (const [id, pool] of [
      ['claude-solo:haiku-5.5:claude-code', 'claude-solo'],
      ['claude-carpool:haiku-5.5:claude-code', 'claude-carpool'],
    ] as const) {
      const route = example.routes.find((r) => r.id === id);
      expect([route?.poolId, route?.hostId, route?.modelId, route?.upstreamModel], id).toEqual([
        pool,
        'claude-code',
        'haiku-5.5',
        'claude-haiku-5-5',
      ]);
    }
  });

  it('界面用途里没有 GPT（照旧目录配置）、判断只用 Jev', async () => {
    const cfg = await loadRoutingConfig();
    expect(cfg.purposes.ui?.some((m) => m.startsWith('gpt'))).toBe(false);
    expect(cfg.purposes.judge).toEqual(['jev-1.13']);
  });

  it('gpt-6-sol（创始人 2026-10-07：reviewer 默认走 mirasim）在骨架里开着、只进 verify 且排第一、不进界面和动手；目录里有它：Mirasim 中转、mirasim 执行方式、族 gpt；旧的错名 gpt-6.1-sol 哪里都没有', async () => {
    const cfg = await loadRoutingConfig();
    expect(cfg.models['gpt-6-sol']?.map((r) => [r.routeId, r.enabled])).toEqual([
      ['mirasim-relay:gpt-6-sol:mirasim', true],
    ]);
    expect(cfg.purposes.verify?.[0]).toBe('gpt-6-sol');
    const usedIn = Object.entries(cfg.purposes)
      .filter(([, order]) => order.includes('gpt-6-sol'))
      .map(([purpose]) => purpose);
    expect(usedIn).toEqual(['verify']);
    expect(JSON.stringify(cfg)).not.toContain('gpt-6.1-sol');
    const example = parseCatalog(repoFile('deploy/catalog.json'), 'deploy/catalog.json');
    const route = example.routes.find((r) => r.id === 'mirasim-relay:gpt-6-sol:mirasim');
    expect([route?.poolId, route?.hostId, route?.modelId, route?.upstreamModel]).toEqual([
      'mirasim-relay',
      'mirasim',
      'gpt-6-sol',
      // 模型 id 是 gpt-6-sol，点名的串是中转名单里的 gpt-6.1-sol（点 gpt-6-sol 会被服务端悄悄换成 gpt-6-astra，#1298）
      'gpt-6.1-sol',
    ]);
    expect(example.models.find((m) => m.id === 'gpt-6-sol')?.family).toBe('gpt');
    // 模型 id 不叫 gpt-6.1-sol：只有这一条路由的点名串是它
    expect(example.models.some((m) => m.id === 'gpt-6.1-sol')).toBe(false);
  });

  it('目录里每个没排进任何用途的模型（先「可选」的）：骨架 models 里有它，目录里它的每条路由都在、且全部关着（新补的不改现有派活，#1286）', async () => {
    const cfg = await loadRoutingConfig();
    const catalog = parseCatalog(repoFile('deploy/catalog.json'), 'deploy/catalog.json');
    const dispatched = new Set(Object.values(cfg.purposes).flat());
    const problems: string[] = [];
    for (const m of catalog.models) {
      if (dispatched.has(m.id)) continue;
      const inSkeleton = cfg.models[m.id];
      if (!inSkeleton) {
        problems.push(`模型 ${m.id} 没排进任何用途，骨架 models 里也没有`);
        continue;
      }
      const want = catalog.routes.filter((r) => r.modelId === m.id).map((r) => r.id);
      if (JSON.stringify([...want].sort()) !== JSON.stringify(inSkeleton.map((r) => r.routeId).sort()))
        problems.push(`模型 ${m.id} 在骨架里挂的路由和目录里不一样`);
      for (const r of inSkeleton)
        if (r.enabled) problems.push(`路由 ${r.routeId} 开着，但模型 ${m.id} 不在任何用途里`);
    }
    expect(problems).toEqual([]);
  });

  it('【故意造出的失败】gpt-6-sol 放进界面用途：硬禁令 gpt-no-ui 照拦；验收等别的用途不拦', () => {
    const sol = {
      id: 'gpt-6-sol',
      family: 'gpt',
      displayName: 'GPT 6 sol',
      upstreamModel: 'gpt-6-sol',
    };
    expect(hardBanFor(sol, 'ui')?.id).toBe('gpt-no-ui');
    expect(hardBanFor(sol, 'verify')).toBeUndefined();
    // 骨架里把它塞进 ui 的话，「界面用途里没有 GPT」那一条的判法会抓到
    expect(['grok-4.7', 'gpt-6-sol'].some((m) => m.startsWith('gpt'))).toBe(true);
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
    const example = parseCatalog(repoFile('deploy/catalog.json'), 'deploy/catalog.json');
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
