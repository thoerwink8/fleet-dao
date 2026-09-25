import { readFileSync } from 'node:fs';
import { windowAppliesTo } from '@fleet-dao/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_DEFAULT_PATH,
  type CatalogConfig,
  CatalogError,
  catalogPath,
  loadCatalog,
  parseCatalog,
  readCatalogFile,
} from '../src/catalog.ts';
import type { Db } from '../src/client.ts';
import { stageCandidates } from '../src/queries/candidates.ts';
import { STAGE_KINDS } from '../src/schema/enums.ts';
import {
  auditLog,
  channels,
  families,
  models,
  pools,
  routes,
  stagePolicies,
  stagePolicyRoutes,
} from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { NOW } from './helpers.ts';

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const EXAMPLE_PATH = 'deploy/examples/catalog.example.json';
const exampleText = repoFile(EXAMPLE_PATH);
const example = () => parseCatalog(exampleText, EXAMPLE_PATH);

const CLAUDE_ROUTES = ['claude-solo:opus-5.5:claude-code', 'claude-carpool:opus-5.5:claude-code'];

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

const load = (config: CatalogConfig = example()) => loadCatalog(t.db, config, { now: NOW, source: 'test' });

/** 目录相关的几张表的全部内容，按主键排好。 */
async function catalogRows(db: Db) {
  return {
    families: await db.select().from(families).orderBy(asc(families.id)),
    channels: await db.select().from(channels).orderBy(asc(channels.id)),
    pools: await db.select().from(pools).orderBy(asc(pools.id)),
    models: await db.select().from(models).orderBy(asc(models.id)),
    routes: await db.select().from(routes).orderBy(asc(routes.id)),
    stagePolicies: await db.select().from(stagePolicies).orderBy(asc(stagePolicies.stage)),
    stagePolicyRoutes: await db
      .select()
      .from(stagePolicyRoutes)
      .orderBy(asc(stagePolicyRoutes.stage), asc(stagePolicyRoutes.position)),
  };
}

async function stageOrder(stage: (typeof STAGE_KINDS)[number]) {
  const rows = await t.db
    .select()
    .from(stagePolicyRoutes)
    .where(eq(stagePolicyRoutes.stage, stage))
    .orderBy(asc(stagePolicyRoutes.position));
  return rows.map((r) => [r.routeId, r.enabled]);
}

describe('示例配置 deploy/examples/catalog.example.json', () => {
  it('装得进空库：每个阶段先是两个 Claude 池的 Opus（开着），其余路由挂在后面关着', async () => {
    const result = await load();
    expect(result.inserted.stages).toEqual([...STAGE_KINDS]);
    const config = example();
    const expected = config.routes.map((r) => [r.id, CLAUDE_ROUTES.includes(r.id)]);
    for (const stage of STAGE_KINDS) {
      // ui 单列一份，不挂 GPT（硬禁令，关着也不挂）。
      const want = stage === 'ui' ? expected.filter(([id]) => !String(id).includes('gpt')) : expected;
      expect(await stageOrder(stage)).toEqual(want);
    }
    expect((await stageOrder('ui')).length).toBe(expected.length - 1);
    // 关着的照样列在候选表里、带着原因。
    const execute = await stageCandidates(t.db, 'execute', { now: NOW });
    expect(execute.candidates.map((c) => [c.routeId, !c.blockers.includes('switched-off')])).toEqual(
      expected,
    );
  });

  it('账号池和额度读取器的配置样例一一对应（额度按池入库，池不在库里就写不进去）', () => {
    const quota = JSON.parse(repoFile('deploy/examples/quota.example.json')) as {
      pools: { poolId: string; channelId: string }[];
    };
    const pairs = (list: { id: string; channelId: string }[]) =>
      list.map((p) => `${p.id}@${p.channelId}`).sort();
    expect(pairs(example().pools)).toEqual(
      pairs(quota.pools.map((p) => ({ id: p.poolId, channelId: p.channelId }))),
    );
  });

  it('上游名字和插头、额度读取器的真夹具对得上', () => {
    const route = (id: string) => example().routes.find((r) => r.id === id);
    // Claude Code：插头实跑时发的、流里回显的模型名。
    const cc = repoFile('packages/adapters/test/fixtures/claude-code/cc-opus-edit-bash.ndjson');
    const ccModel = (JSON.parse(cc.split('\n')[0] ?? '{}') as { model?: string }).model;
    for (const id of CLAUDE_ROUTES) expect(route(id)?.upstreamModel).toBe(ccModel);
    // Cursor：Auto 在额度接口的成员表里叫 default。
    const cursor = JSON.parse(
      repoFile('packages/adapters/test/quota/fixtures/cursor-period-usage-2026-09-24.json'),
    ) as { autoBucketModels: string[] };
    const auto = route('cursor:cursor-auto:cursor-agent');
    const members = { auto: { in: cursor.autoBucketModels }, api: { notIn: cursor.autoBucketModels } };
    const ref = {
      id: 'cursor-auto',
      upstreamNames: [auto?.upstreamModel ?? '', ...(auto?.upstreamAliases ?? [])],
    };
    expect(windowAppliesTo({ scope: 'auto' }, ref, members)).toBe('yes');
    expect(windowAppliesTo({ scope: 'api' }, ref, members)).toBe('no');
    // Grok：终帧里回的模型名。
    const grok = repoFile('packages/adapters/test/fixtures/grok/grok-read.ndjson');
    const grokAliases = route('grok:grok-4.7:grok')?.upstreamAliases ?? [];
    expect(grokAliases.length).toBeGreaterThan(0);
    for (const alias of grokAliases) expect(grok).toContain(`"${alias}"`);
    // 中转：只扣某一族的窗（7d_claude）扣经中转的 Opus，不扣 GPT、Kimi、DeepSeek。
    const relay = JSON.parse(
      repoFile('packages/adapters/test/quota/fixtures/mirasim-relay-2026-09-24.json'),
    ) as {
      relay: { usage: { windows: { label: string; modelScoped?: boolean }[] } };
    };
    expect(relay.relay.usage.windows.map((w) => w.label)).toContain('7d_claude');
    const family = new Map(example().models.map((m) => [m.id, m.family]));
    const relayRoutes = example().routes.filter((r) => r.poolId === 'mirasim-relay');
    expect(
      relayRoutes.map((r) => [
        r.modelId,
        windowAppliesTo({ scope: 'claude' }, { id: r.modelId, family: family.get(r.modelId) ?? '' }),
      ]),
    ).toEqual([
      ['opus-5.5', 'yes'],
      ['gpt-5.6-luna', 'no'],
      ['kimi-k3', 'no'],
      ['deepseek-flash', 'no'],
    ]);
  });

  it('不带账号信息：没有邮箱、IP、像密钥的长串', () => {
    expect(exampleText).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(exampleText).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(exampleText).not.toMatch(/[A-Za-z0-9_-]{32,}/);
  });
});

describe('只补缺，跑几遍都一样', () => {
  it('装两遍：第二遍一行不改，也不多记一条操作记录', async () => {
    const first = await load();
    expect(first.unchanged).toBe(false);
    const rows = await catalogRows(t.db);
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => [a.actorId, a.action])).toEqual([['catalog-loader', 'catalog.load']]);

    const second = await load();
    expect(second).toEqual({
      inserted: { families: [], channels: [], pools: [], models: [], routes: [], stages: [] },
      filled: [],
      adoptedStages: [],
      kept: [],
      unchanged: true,
    });
    expect(await catalogRows(t.db)).toEqual(rows);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it('驾驶舱改过的不被覆盖：排序、开关、删掉的、清空的阶段，池的并发、路由的上游名字、渠道开关', async () => {
    await load();
    const [solo, carpool] = CLAUDE_ROUTES as [string, string];
    // execute：两条 Claude 调个个儿，再打开 Grok。
    const inExecute = (routeId: string) =>
      and(eq(stagePolicyRoutes.stage, 'execute'), eq(stagePolicyRoutes.routeId, routeId));
    await t.db.update(stagePolicyRoutes).set({ position: 99 }).where(inExecute(solo));
    await t.db.update(stagePolicyRoutes).set({ position: 0 }).where(inExecute(carpool));
    await t.db.update(stagePolicyRoutes).set({ position: 1 }).where(inExecute(solo));
    await t.db.update(stagePolicyRoutes).set({ enabled: true }).where(inExecute('grok:grok-4.7:grok'));
    // plan 清空（驾驶舱把这个阶段的路由全摘了），review 只留一条。
    await t.db.delete(stagePolicyRoutes).where(eq(stagePolicyRoutes.stage, 'plan'));
    await t.db.delete(stagePolicyRoutes).where(eq(stagePolicyRoutes.stage, 'review'));
    await t.db
      .insert(stagePolicyRoutes)
      .values({ stage: 'review', routeId: carpool, position: 0, enabled: true });
    await t.db.update(pools).set({ maxConcurrency: 1 }).where(eq(pools.id, 'claude-solo'));
    await t.db.update(routes).set({ upstreamModel: 'claude-opus-5-5[1m]' }).where(eq(routes.id, solo));
    await t.db.update(channels).set({ enabled: false }).where(eq(channels.id, 'cursor'));
    const edited = await catalogRows(t.db);

    const again = await load();
    expect(await catalogRows(t.db)).toEqual(edited);
    expect(again.unchanged).toBe(true);
    // 不一样的都写明了，给人看。
    expect(again.kept).toEqual(
      expect.arrayContaining([
        'channels.cursor.enabled：库里是 false，配置是 true，没动',
        'pools.claude-solo.maxConcurrency：库里是 1，配置是 3，没动',
        `routes.${solo}.upstreamModel：库里是 "claude-opus-5-5[1m]"，配置是 "claude-opus-5-5"，没动`,
        '阶段 execute：装载器早先排过，之后不再动它，和配置不一样，没动',
      ]),
    );
    // 摘掉的路由点名出来，不笼统说「改过顺序」。
    const stageNotes = again.kept.filter((k) => k.startsWith('阶段'));
    expect(stageNotes).toHaveLength(3);
    const notCarpool = example()
      .routes.map((r) => r.id)
      .filter((id) => id !== carpool);
    expect(stageNotes).toContain(
      `阶段 review：装载器早先排过，之后不再动它，配置里的 ${notCarpool.join('、')} 没挂上（要用就在驾驶舱里加）`,
    );
    expect(stageNotes.find((k) => k.startsWith('阶段 plan'))).toContain(`配置里的 ${solo}、${carpool}、`);
  });

  it('库里早先就有的：路由空着的上游名字、池空着的会话用户补上，已有的阶段顺序接手下来不动', async () => {
    await load({ ...example(), routes: example().routes.map((r) => ({ ...r, upstreamAliases: [] })) });
    // 模拟装载器之前手工建的：上游名字、会话用户都空着；execute 阶段有人排过。
    await t.db.update(routes).set({ upstreamModel: null, upstreamAliases: [] });
    await t.db.update(pools).set({ runAsUser: null });
    await t.db
      .update(stagePolicies)
      .set({ catalogAppliedAt: null })
      .where(eq(stagePolicies.stage, 'execute'));
    await t.db.delete(stagePolicyRoutes).where(eq(stagePolicyRoutes.stage, 'execute'));
    await t.db
      .insert(stagePolicyRoutes)
      .values({ stage: 'execute', routeId: 'grok:grok-4.7:grok', position: 0, enabled: true });

    const result = await load();
    expect(result.filled).toEqual(
      expect.arrayContaining([
        'pools.claude-solo.runAsUser',
        'pools.claude-carpool.runAsUser',
        'routes.claude-solo:opus-5.5:claude-code.upstreamModel',
        'routes.cursor:cursor-auto:cursor-agent.upstreamAliases',
        'routes.grok:grok-4.7:grok.upstreamAliases',
      ]),
    );
    const [auto] = await t.db.select().from(routes).where(eq(routes.id, 'cursor:cursor-auto:cursor-agent'));
    expect([auto?.upstreamModel, auto?.upstreamAliases]).toEqual(['auto', ['default']]);
    const [solo] = await t.db.select().from(pools).where(eq(pools.id, 'claude-solo'));
    expect(solo?.runAsUser).toBe('fleet-agent-dedicated');
    // 有人排过的 execute 接手下来，不改；以后也不再动。
    expect(result.adoptedStages).toEqual(['execute']);
    expect(await stageOrder('execute')).toEqual([['grok:grok-4.7:grok', true]]);
    expect((await load()).unchanged).toBe(true);
  });

  it('钉住的阶段不排', async () => {
    await t.db.insert(stagePolicies).values({ stage: 'ui', pinned: true });
    const result = await load();
    expect(result.inserted.stages).not.toContain('ui');
    expect(result.adoptedStages).toEqual(['ui']);
    expect(await stageOrder('ui')).toEqual([]);
  });

  it('排过之后配置里新加的路由：路由写进库，已排过的阶段不挂，点名说没挂上', async () => {
    await load();
    const base = example();
    const extra = {
      ...(base.routes[0] as CatalogConfig['routes'][number]),
      id: 'solo-2',
      hostId: 'mirasim' as const,
    };
    const result = await load({
      ...base,
      routes: [...base.routes, extra],
      stages: {
        ...base.stages,
        default: [...(base.stages.default ?? []), { routeId: 'solo-2', enabled: true }],
      },
    });
    expect(result.inserted.routes).toEqual(['solo-2']);
    expect(result.kept).toContain(
      '阶段 execute：装载器早先排过，之后不再动它，配置里的 solo-2 没挂上（要用就在驾驶舱里加）',
    );
    expect((await stageOrder('execute')).map(([id]) => id)).not.toContain('solo-2');
  });

  it('会话用户那一列按名字读得回来（session_user 是保留字，裸写会读到连接角色）', async () => {
    await load();
    const { rows } = await t.client.query<{ id: string; run_as_user: string | null }>(
      `select id, run_as_user from pools where id in ('claude-solo', 'claude-carpool') order by id`,
    );
    expect(rows).toEqual([
      { id: 'claude-carpool', run_as_user: 'fleet-agent-carpool' },
      { id: 'claude-solo', run_as_user: 'fleet-agent-dedicated' },
    ]);
  });
});

describe('拒收：撞约束、撞硬禁令、写到一半失败，库里一行不写', () => {
  const failLoad = async (config: CatalogConfig) => {
    const err = await load(config).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CatalogError);
    return (err as CatalogError).message;
  };
  const empty = async () => Object.values(await catalogRows(t.db)).every((list) => list.length === 0);
  const routeOf = (id: string) =>
    example().routes.find((r) => r.id === id) as CatalogConfig['routes'][number];

  it('（池, 模型, 执行方式）一样、id 不一样的两条路由：配置里就报；和库里的撞了也报，不当成「一行没改」', async () => {
    const base = example();
    const twin = { ...routeOf('grok:grok-4.7:grok'), id: 'grok-twin' };
    expect(() => parseCatalog(JSON.stringify({ ...base, routes: [...base.routes, twin] }))).toThrow(
      /routes 里（账号池 \/ 模型 \/ 执行方式）grok \/ grok-4\.7 \/ grok 出现了不止一次/,
    );

    await load();
    const before = await catalogRows(t.db);
    const message = await failLoad({
      ...base,
      routes: [...base.routes.filter((r) => r.id !== 'grok:grok-4.7:grok'), twin],
      stages: { default: [{ routeId: 'grok-twin', enabled: false }] },
    });
    expect(message).toContain(
      '路由 grok-twin 和库里的 grok:grok-4.7:grok 是同一条线（grok / grok-4.7 / grok）',
    );
    expect(await catalogRows(t.db)).toEqual(before);
  });

  it('GPT 族写成 openai、上游名是 Fable、模型本身是 Fable：一律拒收', async () => {
    const base = example();
    // GPT 族写成 openai、ui 没单列（用 default，里面挂着 GPT，关着也不行）。
    const openai: CatalogConfig = {
      ...base,
      families: [
        ...base.families.filter((f) => f.id !== 'gpt'),
        { id: 'openai', displayName: 'OpenAI', vendor: 'OpenAI' },
      ],
      models: base.models.map((m) => (m.family === 'gpt' ? { ...m, family: 'openai' } : m)),
      stages: { default: base.stages.default ?? [] },
    };
    expect(await failLoad(openai)).toContain(
      'stages.default 的路由 mirasim-relay:gpt-5.6-luna:mirasim 不能用在 ui（没单列这个阶段，用的是 default）：GPT 不做 UI 类活',
    );
    // 模型 id 叫 opus、插头发给上游的却是 Fable：哪个阶段都不行。
    const solo = 'claude-solo:opus-5.5:claude-code';
    const fableUpstream: CatalogConfig = {
      ...base,
      routes: base.routes.map((r) => (r.id === solo ? { ...r, upstreamModel: 'claude-fable-5-1' } : r)),
    };
    expect(await failLoad(fableUpstream)).toContain(`路由 ${solo}：不用 Fable`);
    // 模型本身是 Fable（没挂路由也拒收）。
    const fableModel: CatalogConfig = {
      ...base,
      models: [...base.models, { id: 'fable-5.1', family: 'claude', displayName: 'Fable 5.1' }],
    };
    expect(await failLoad(fableModel)).toContain('模型 fable-5.1：不用 Fable');
    expect(await empty()).toBe(true);
  });

  it('会话用户只许 fleet-agent-dedicated / fleet-agent-carpool：配置里写别的报错，库里也有约束', async () => {
    const base = example();
    const bad = { ...base, pools: base.pools.map((p, i) => (i === 0 ? { ...p, runAsUser: 'root' } : p)) };
    expect(() => parseCatalog(JSON.stringify(bad))).toThrow(/pools\.0\.runAsUser/);
    await load();
    await expect(
      t.client.query(`update pools set run_as_user = 'root' where id = 'claude-solo'`),
    ).rejects.toThrow(/pools_run_as_user_known/);
  });

  it('写到一半失败（排阶段顺序时库里报错）：前面写进去的族、渠道、池、模型、路由整批回滚', async () => {
    await t.client.exec(`
      create function catalog_test_boom() returns trigger language plpgsql as $$
      begin raise exception 'catalog_test_boom'; end $$;
      create trigger catalog_test_boom before insert on stage_policy_routes
        for each row execute function catalog_test_boom();
    `);
    try {
      const err = await load().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/^Failed query: insert into "stage_policy_routes"/);
      expect(String(err?.cause)).toMatch(/catalog_test_boom/);
      expect(await empty()).toBe(true);
      expect(await t.db.select().from(auditLog)).toEqual([]);
    } finally {
      await t.client.exec(`
        drop trigger catalog_test_boom on stage_policy_routes;
        drop function catalog_test_boom();
      `);
    }
  });
});

describe('配置文件缺失或格式错：明确报错，库里一行不写', () => {
  const fail = async (read: Promise<unknown>) => {
    const err = await read.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CatalogError);
    return (err as CatalogError).message;
  };
  const text = (value: unknown) => async () => JSON.stringify(value);

  it('文件不在、读不了', async () => {
    const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(await fail(readCatalogFile('/etc/fleet-dao/catalog.json', () => Promise.reject(missing)))).toMatch(
      /catalog\.json 文件不存在；装载器不会当成空目录继续/,
    );
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(await fail(readCatalogFile('/x.json', () => Promise.reject(denied)))).toMatch(
      /读不了（permission denied）/,
    );
  });

  it('不是 JSON、是空的、缺整块', async () => {
    expect(await fail(readCatalogFile('/x.json', async () => '{ "channels": ['))).toMatch(/不是合法的 JSON/);
    expect(await fail(readCatalogFile('/x.json', async () => ''))).toMatch(/不是合法的 JSON/);
    const empty = await fail(readCatalogFile('/x.json', text({})));
    for (const part of ['channels', 'pools', 'routes', 'stages']) expect(empty).toContain(`- ${part}：`);
    const noLists = await fail(readCatalogFile('/x.json', text({ ...example(), pools: [], stages: {} })));
    expect(noLists).toContain('- pools：');
    expect(noLists).toContain('至少要有 default 或某个阶段的顺序');
  });

  it('字段写错、阶段名写错、取值不对、id 重复', async () => {
    const base = example();
    const [pool] = base.pools;
    const typo = await fail(
      readCatalogFile(
        '/x.json',
        text({
          ...base,
          pools: [{ ...pool, maxConcurency: 3 }, ...base.pools.slice(1)],
          stages: { deploy: [] },
        }),
      ),
    );
    expect(typo).toContain('maxConcurency');
    expect(typo).toContain('stages');
    expect(
      await fail(
        readCatalogFile('/x.json', text({ ...base, channels: [{ ...base.channels[0], billing: 'free' }] })),
      ),
    ).toContain('channels.0.billing');
    expect(
      await fail(readCatalogFile('/x.json', text({ ...base, routes: [...base.routes, base.routes[0]] }))),
    ).toContain(`routes 里 ${base.routes[0]?.id} 出现了不止一次`);
  });

  it('引用了不存在的池、模型、路由：整批不写', async () => {
    const base = example();
    const broken: CatalogConfig = {
      ...base,
      routes: [
        ...base.routes,
        { ...(base.routes[0] as CatalogConfig['routes'][number]), id: 'x', poolId: 'nowhere' },
      ],
      stages: { default: [...(base.stages.default ?? []), { routeId: 'ghost', enabled: true }] },
    };
    const message = await fail(load(broken));
    expect(message).toContain('路由 x 的账号池 nowhere 不存在');
    expect(message).toContain('stages.default 的路由 ghost 不存在');
    const rows = await catalogRows(t.db);
    expect(Object.values(rows).every((list) => list.length === 0)).toBe(true);
  });
});

describe('命令行', () => {
  it('配置文件：命令行参数 > FLEET_CATALOG > 默认路径', () => {
    expect(catalogPath(['/tmp/a.json'], { FLEET_CATALOG: '/tmp/b.json' })).toBe('/tmp/a.json');
    expect(catalogPath([], { FLEET_CATALOG: '/tmp/b.json' })).toBe('/tmp/b.json');
    expect(catalogPath([], {})).toBe(CATALOG_DEFAULT_PATH);
    expect(CATALOG_DEFAULT_PATH).toBe('/etc/fleet-dao/catalog.json');
  });
});
