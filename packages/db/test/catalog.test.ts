import { readFileSync } from 'node:fs';
import { windowAppliesTo } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
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
import {
  auditLog,
  channels,
  families,
  models,
  pools,
  routes,
  routingCatalog,
  routingPurposeModels,
} from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { NOW } from './helpers.ts';

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const EXAMPLE_PATH = 'deploy/catalog.json';
const exampleText = repoFile(EXAMPLE_PATH);
const example = () => parseCatalog(exampleText, EXAMPLE_PATH);

/** 目录里的账号池和额度配置里的池对不上的两边：只在额度配置里的、只在目录里的（都按「池号@渠道」排好）。 */
function quotaOnlyAndCatalogOnly(
  catalogPools: { id: string; channelId: string }[],
  quotaPools: { poolId: string; channelId: string }[],
) {
  const cat = new Set(catalogPools.map((p) => `${p.id}@${p.channelId}`));
  const quota = new Set(quotaPools.map((p) => `${p.poolId}@${p.channelId}`));
  return {
    quotaOnly: [...quota].filter((k) => !cat.has(k)).sort(),
    catalogOnly: [...cat].filter((k) => !quota.has(k)).sort(),
  };
}

const CLAUDE_ROUTES = ['claude-solo:opus-5.5:claude-code', 'claude-carpool:opus-5.5:claude-code'];
const GROK_ROUTE = 'grok:grok-4.7:grok';
/** Mirasim 中转的 DeepSeek Flash（#345，创始人 2026-09-27 拍「mirasim 额度不够，先只开这一条」）。 */
const DEEPSEEK_ROUTE = 'mirasim-relay:deepseek-flash:mirasim';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

const load = (config: CatalogConfig = example()) => loadCatalog(t.db, config, { now: NOW, source: 'test' });

/** 目录相关的几张表的全部内容（装载器照旧的依据），按主键排好。 */
async function catalogRows(db: Db) {
  return {
    families: await db.select().from(families).orderBy(families.id),
    channels: await db.select().from(channels).orderBy(channels.id),
    pools: await db.select().from(pools).orderBy(pools.id),
    models: await db.select().from(models).orderBy(models.id),
    routes: await db.select().from(routes).orderBy(routes.id),
  };
}

describe('目录配置 deploy/catalog.json（发布时装进库的真文件）', () => {
  it('装得进空库：族、渠道、账号池、模型、路由都照样例写进去', async () => {
    const result = await load();
    const config = example();
    expect(result.inserted.families).toEqual(config.families.map((f) => f.id));
    expect(result.inserted.channels).toEqual(config.channels.map((c) => c.id));
    expect(result.inserted.pools).toEqual(config.pools.map((p) => p.id));
    expect(result.inserted.models).toEqual(config.models.map((m) => m.id));
    expect(result.inserted.routes).toEqual(config.routes.map((r) => r.id));
    expect(result.unchanged).toBe(false);
  });

  it('目录写了 identityCheck 就装进库为 true，没写为 false（#1798 片 2）', async () => {
    await load();
    const rows = await t.db.select({ id: channels.id, identityCheck: channels.identityCheck }).from(channels);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.identityCheck]));
    expect(byId.mirasim).toBe(true);
    expect(byId.cursor).toBe(false);
    expect(byId['claude-sub']).toBe(false);
    // 库里被改成 false 后，再装一次按目录对齐回来
    await t.db.update(channels).set({ identityCheck: false }).where(eq(channels.id, 'mirasim'));
    const again = await load();
    expect(again.filled).toContain('channels.mirasim.identityCheck');
    const [mira] = await t.db
      .select({ identityCheck: channels.identityCheck })
      .from(channels)
      .where(eq(channels.id, 'mirasim'));
    expect(mira?.identityCheck).toBe(true);
  });

  it('装进空库，每张表的行数和样例对得上', async () => {
    const config = example();
    await load();
    const rows = await catalogRows(t.db);
    expect(Object.fromEntries(Object.entries(rows).map(([kind, list]) => [kind, list.length]))).toEqual({
      families: config.families.length,
      channels: config.channels.length,
      pools: config.pools.length,
      models: config.models.length,
      routes: config.routes.length,
    });
  });

  it('样例里不再有 stages（旧的按阶段平铺顺序，#754）：谁还写它，装载器明确拒收、说清删哪一段', async () => {
    expect(exampleText).not.toContain('"stages"');
    const withStages = JSON.stringify({
      ...example(),
      stages: { default: [{ routeId: GROK_ROUTE, enabled: true }] },
    });
    // 报的是 stages 这一段，不是笼统一句「认不出的字段」。
    expect(() => parseCatalog(withStages, EXAMPLE_PATH)).toThrow(
      /里还有旧的 stages（各阶段的路由顺序）[\s\S]*把这份配置里的整个 stages 那一段删掉再发布/,
    );
    // 不含 stages 的那份照常装得进去。
    await expect(load(example())).resolves.toBeTruthy();
  });

  it('两个 Claude 池跑在同一个会话用户下、按组织类型分（法国只留一个会话用户，design 第十节）；同一时刻只有一个在跑，各 4', () => {
    const pool = (id: string) => example().pools.find((p) => p.id === id);
    const facts = (id: string) => [pool(id)?.runAsUser, pool(id)?.orgKind, pool(id)?.maxConcurrency];
    expect(facts('claude-solo')).toEqual(['fleet-agent-carpool', 'solo', 4]);
    expect(facts('claude-carpool')).toEqual(['fleet-agent-carpool', 'carpool', 4]);
  });

  it('账号池和额度配置对得上；只有 jev 不进额度配置（没有日账，花费在 jev_answers，不写按日文件）', () => {
    const quota = JSON.parse(repoFile('deploy/quota.json')) as {
      pools: { poolId: string; channelId: string }[];
    };
    expect(quotaOnlyAndCatalogOnly(example().pools, quota.pools)).toEqual({
      quotaOnly: [],
      catalogOnly: ['jev@jev'],
    });
    const notRead = (quota as { notRead?: { poolId: string; why: string }[] }).notRead ?? [];
    expect(notRead.map((p) => p.poolId)).toEqual(['jev']);
    expect(notRead[0]?.why).toContain('没有旧系统的日账');
  });

  it('【故意造出失败】额度配置少一个目录里有的池（或多一个目录里没有的池），对照就判红', () => {
    const quota = JSON.parse(repoFile('deploy/quota.json')) as {
      pools: { poolId: string; channelId: string }[];
    };
    const missing = quota.pools.filter((p) => p.poolId !== 'grok');
    expect(quotaOnlyAndCatalogOnly(example().pools, missing)).toEqual({
      quotaOnly: [],
      catalogOnly: ['grok@xai', 'jev@jev'],
    });
    const extra = [...quota.pools, { poolId: 'ghost', channelId: 'x' }];
    expect(quotaOnlyAndCatalogOnly(example().pools, extra)).toEqual({
      quotaOnly: ['ghost@x'],
      catalogOnly: ['jev@jev'],
    });
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
      ['sonnet-5.5', 'yes'],
      ['opus-5.5', 'yes'],
      ['gpt-5.6-luna', 'no'],
      ['gpt-6-sol', 'no'],
      ['gpt-6-luna', 'no'],
      ['gpt-6-astra', 'no'],
      ['gpt-5.6-sol', 'no'],
      ['gpt-5.6-terra', 'no'],
      ['kimi-k3', 'no'],
      ['deepseek-flash', 'no'],
      ['deepseek-v4-pro', 'no'],
      ['glm-5.3-flash', 'no'],
      ['glm-5.3', 'no'],
    ]);
  });

  it('说明里指的 docs/ops.md 第九节「目录配置」在（那一段挪走、改名了这里会红）', () => {
    expect(exampleText).toContain('docs/ops.md 第九节「目录配置」');
    const ops = repoFile('docs/ops.md').split('\n');
    const start = ops.findIndex((l) => l.startsWith('## 九、'));
    const end = ops.findIndex((l, i) => i > start && l.startsWith('## '));
    expect(start).toBeGreaterThan(-1);
    expect(ops.slice(start, end === -1 ? undefined : end).some((l) => l.startsWith('目录配置（'))).toBe(true);
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
      inserted: { families: [], channels: [], pools: [], models: [], routes: [] },
      filled: [],
      kept: [],
      unchanged: true,
    });
    expect(await catalogRows(t.db)).toEqual(rows);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it('驾驶舱改过的不被覆盖：池的并发、路由的上游名字、渠道开关', async () => {
    await load();
    const [solo, carpool] = CLAUDE_ROUTES as [string, string];
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
        'pools.claude-solo.maxConcurrency：库里是 1，配置是 4，没动',
        `routes.${solo}.upstreamModel：库里是 "claude-opus-5-5[1m]"，配置是 "claude-opus-5-5"，没动`,
      ]),
    );
    expect(carpool).toBeTruthy();
  });

  it('库里早先就有的：路由空着的上游名字、池空着的会话用户补上', async () => {
    await load({ ...example(), routes: example().routes.map((r) => ({ ...r, upstreamAliases: [] })) });
    // 模拟装载器之前手工建的：上游名字、会话用户都空着。
    await t.db.update(routes).set({ upstreamModel: null, upstreamAliases: [] });
    await t.db.update(pools).set({ runAsUser: null, orgKind: null });

    const result = await load();
    expect(result.filled).toEqual(
      expect.arrayContaining([
        'pools.claude-solo.runAsUser',
        'pools.claude-solo.orgKind',
        'pools.claude-carpool.runAsUser',
        'pools.claude-carpool.orgKind',
        'routes.claude-solo:opus-5.5:claude-code.upstreamModel',
        'routes.cursor:cursor-auto:cursor-agent.upstreamAliases',
        'routes.grok:grok-4.7:grok.upstreamAliases',
      ]),
    );
    const [auto] = await t.db.select().from(routes).where(eq(routes.id, 'cursor:cursor-auto:cursor-agent'));
    expect([auto?.upstreamModel, auto?.upstreamAliases]).toEqual(['auto', ['default']]);
    const [solo] = await t.db.select().from(pools).where(eq(pools.id, 'claude-solo'));
    expect([solo?.runAsUser, solo?.orgKind]).toEqual(['fleet-agent-carpool', 'solo']);
    expect((await load()).unchanged).toBe(true);
  });

  it('配置里新加的路由：发布时装得进库（要派活还得挂进路由两层）', async () => {
    await load();
    const base = example();
    const extra = {
      ...(base.routes[0] as CatalogConfig['routes'][number]),
      id: 'solo-2',
      hostId: 'mirasim' as const,
    };
    const result = await load({ ...base, routes: [...base.routes, extra] });
    expect(result.inserted.routes).toEqual(['solo-2']);
    expect((await load({ ...base, routes: [...base.routes, extra] })).unchanged).toBe(true);
  });

  it('会话用户那一列按名字读得回来（session_user 是保留字，裸写会读到连接角色）', async () => {
    await load();
    const { rows } = await t.client.query<{ id: string; run_as_user: string | null }>(
      `select id, run_as_user from pools where id in ('claude-solo', 'claude-carpool') order by id`,
    );
    expect(rows).toEqual([
      { id: 'claude-carpool', run_as_user: 'fleet-agent-carpool' },
      { id: 'claude-solo', run_as_user: 'fleet-agent-carpool' },
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
    });
    expect(message).toContain(
      '路由 grok-twin 和库里的 grok:grok-4.7:grok 是同一条线（grok / grok-4.7 / grok）',
    );
    expect(await catalogRows(t.db)).toEqual(before);
  });

  it('发现层自动入的变体路由（auto:…）和手写路由共用（池, 模型, 执行方式）：再装一遍目录照过，不当成「同一条线」', async () => {
    await load();
    const base = routeOf('grok:grok-4.7:grok');
    await t.db.insert(routes).values({
      id: 'auto:xai:grok-4.7-fast',
      channelId: 'xai',
      poolId: base.poolId,
      modelId: base.modelId,
      hostId: base.hostId,
      alive: false,
      upstreamModel: 'grok-4.7-fast',
    });
    await expect(load()).resolves.toBeDefined();
  });

  it('Fable 进目录（决定 0033）：模型、路由（上游串是 Fable 的也算）都装得进，路由两层里没有它们的行——默认关着、不在任何用途里', async () => {
    const base = example();
    const solo = 'claude-solo:opus-5.5:claude-code';
    // 模型 id 叫 opus、插头发给上游的却是 Fable：装得进。
    const fableUpstream: CatalogConfig = {
      ...base,
      routes: base.routes.map((r) => (r.id === solo ? { ...r, upstreamModel: 'claude-fable-5-1' } : r)),
    };
    // 模型本身是 Fable（没挂路由）：装得进。
    const fableModel: CatalogConfig = {
      ...fableUpstream,
      models: [...base.models, { id: 'fable-5.1', family: 'claude', displayName: 'Fable 5.1' }],
    };
    const result = await load(fableModel);
    expect(result.inserted.models).toContain('fable-5.1');
    expect(result.inserted.routes).toContain(solo);
    expect((await t.db.select().from(models).where(eq(models.id, 'fable-5.1'))).length).toBe(1);
    // 装载器只写目录那五张表：路由开关表和用途表一行没有，所以没有任何用途里有它、也没有一条路由是开着的
    expect(await t.db.select().from(routingCatalog)).toEqual([]);
    expect(await t.db.select().from(routingPurposeModels)).toEqual([]);
  });

  it('会话用户只许 fleet-agent-carpool：写别的报错，写已停用的 fleet-agent-dedicated 报错并说清改成什么；库里也有约束', async () => {
    const base = example();
    const withPool = (over: Record<string, string>) => ({
      ...base,
      pools: base.pools.map((p, i) => (i === 0 ? { ...p, ...over } : p)),
    });
    expect(() => parseCatalog(JSON.stringify(withPool({ runAsUser: 'root' })))).toThrow(
      /pools\.0\.runAsUser/,
    );
    expect(() => parseCatalog(JSON.stringify(withPool({ runAsUser: 'fleet-agent-dedicated' })))).toThrow(
      /pools\.0\.runAsUser：fleet-agent-dedicated 已停用.*改成 fleet-agent-carpool/,
    );
    expect(() => parseCatalog(JSON.stringify(withPool({ orgKind: 'team' })))).toThrow(/pools\.0\.orgKind/);
    // 带会话用户、漏写组织类型：装载失败，不当成「不是 Claude 池」放过去（放过去就会派到会话用户没挂着的池）
    const noKind = { ...base, pools: base.pools.map((p, i) => (i === 0 ? { ...p, orgKind: undefined } : p)) };
    expect(() => parseCatalog(JSON.stringify(noKind))).toThrow(
      /pools\.0\.orgKind：带会话用户（runAsUser）的池要写 orgKind/,
    );
    // 反过来：不跑会话的池（没有 runAsUser）写了 orgKind 也拒（会被选路当成 Claude 组织池错挡、错放）
    const relayIdx = base.pools.findIndex((p) => p.runAsUser === undefined);
    const kindOnly = {
      ...base,
      pools: base.pools.map((p, i) => (i === relayIdx ? { ...p, orgKind: 'solo' as const } : p)),
    };
    expect(() => parseCatalog(JSON.stringify(kindOnly))).toThrow(
      new RegExp(`pools\\.${relayIdx}\\.runAsUser：orgKind 只给跑会话的 Claude 订阅池写`),
    );
    await load();
    await expect(t.client.query(`update pools set org_kind = null where id = 'claude-solo'`)).rejects.toThrow(
      /pools_session_pool_org_kind_together/,
    );
    await expect(t.client.query(`update pools set org_kind = 'solo' where id = 'jev'`)).rejects.toThrow(
      /pools_session_pool_org_kind_together/,
    );
    await expect(
      t.client.query(`update pools set run_as_user = 'root' where id = 'claude-solo'`),
    ).rejects.toThrow(/pools_run_as_user_known/);
  });

  it('写到一半失败（写账号池时库里报错）：前面写进去的族、渠道整批回滚', async () => {
    await t.client.exec(`
      create function catalog_test_boom() returns trigger language plpgsql as $$
      begin raise exception 'catalog_test_boom'; end $$;
      create trigger catalog_test_boom before insert on pools
        for each row execute function catalog_test_boom();
    `);
    try {
      const err = await load().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/^Failed query: insert into "pools"/);
      expect(String(err?.cause)).toMatch(/catalog_test_boom/);
      expect(await empty()).toBe(true);
      expect(await t.db.select().from(auditLog)).toEqual([]);
    } finally {
      await t.client.exec(`
        drop trigger catalog_test_boom on pools;
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
    expect(await fail(readCatalogFile('/srv/x/deploy/catalog.json', () => Promise.reject(missing)))).toMatch(
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
    for (const part of ['channels', 'pools', 'routes']) expect(empty).toContain(`- ${part}：`);
    const noPools = await fail(readCatalogFile('/x.json', text({ ...example(), pools: [] })));
    expect(noPools).toContain('- pools：');
  });

  it('字段写错、取值不对、id 重复', async () => {
    const base = example();
    const [pool] = base.pools;
    const typo = await fail(
      readCatalogFile(
        '/x.json',
        text({ ...base, pools: [{ ...pool, maxConcurency: 3 }, ...base.pools.slice(1)] }),
      ),
    );
    expect(typo).toContain('maxConcurency');
    expect(
      await fail(
        readCatalogFile('/x.json', text({ ...base, channels: [{ ...base.channels[0], billing: 'free' }] })),
      ),
    ).toContain('channels.0.billing');
    expect(
      await fail(readCatalogFile('/x.json', text({ ...base, routes: [...base.routes, base.routes[0]] }))),
    ).toContain(`routes 里 ${base.routes[0]?.id} 出现了不止一次`);
  });

  it('旧结构那份 stages 还在：明确报错、说清删哪一段，库里一张表都不写', async () => {
    const withStages = { ...example(), stages: { default: [{ routeId: GROK_ROUTE, enabled: true }] } };
    const message = await fail(readCatalogFile('/x.json', text(withStages)));
    expect(message).toContain('里还有旧的 stages（各阶段的路由顺序）');
    expect(Object.values(await catalogRows(t.db)).every((list) => list.length === 0)).toBe(true);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('引用了不存在的池、模型：整批不写', async () => {
    const base = example();
    const broken: CatalogConfig = {
      ...base,
      routes: [
        ...base.routes,
        { ...(base.routes[0] as CatalogConfig['routes'][number]), id: 'x', poolId: 'nowhere' },
      ],
    };
    const message = await fail(load(broken));
    expect(message).toContain('路由 x 的账号池 nowhere 不存在');
    const rows = await catalogRows(t.db);
    expect(Object.values(rows).every((list) => list.length === 0)).toBe(true);
  });
});

describe('命令行', () => {
  it('配置文件：命令行参数 > FLEET_CATALOG > 默认路径', () => {
    expect(catalogPath(['/tmp/a.json'], { FLEET_CATALOG: '/tmp/b.json' })).toBe('/tmp/a.json');
    expect(catalogPath([], { FLEET_CATALOG: '/tmp/b.json' })).toBe('/tmp/b.json');
    expect(catalogPath([], {})).toBe(CATALOG_DEFAULT_PATH);
    // 默认读这一版自带的 deploy/catalog.json，不再是 /etc 下的一份（#1286）；那个文件真在、真能解析
    expect(CATALOG_DEFAULT_PATH.replaceAll('\\', '/')).toMatch(/\/deploy\/catalog\.json$/);
    expect(CATALOG_DEFAULT_PATH).not.toContain('/etc/fleet-dao');
    expect(readFileSync(CATALOG_DEFAULT_PATH, 'utf8')).toBe(exampleText);
  });
});
