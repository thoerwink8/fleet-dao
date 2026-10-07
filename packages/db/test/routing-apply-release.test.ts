// 发布时装路由两层（#574）：bin/routing.ts 在目录装载器之后跑 runRoutingApply。这里拿仓里真的骨架和目录配置样例走一遍：
// 装得进去、再装一次说已齐；读不到骨架、目录还没装（骨架里的路由库里没有）都明确失败、一行不写（发布那一步跟着红）。
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog, parseCatalog } from '../src/catalog.ts';
import { formatRoutingApplyReport, runRoutingApply } from '../src/routing-apply.ts';
import { loadRoutingConfig, ROUTING_DEFAULT_PATH, RoutingConfigError } from '../src/routing-config.ts';
import { STAGE_KINDS } from '../src/schema/enums.ts';
import { routingCatalog, routingPurposeModels } from '../src/schema/index.ts';
import { seed } from '../src/seed.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';

const EXAMPLE_PATH = 'deploy/catalog.json';
const example = () =>
  parseCatalog(readFileSync(new URL(`../../../${EXAMPLE_PATH}`, import.meta.url), 'utf8'), EXAMPLE_PATH);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t);
  await seed(t.db);
});

const rows = async () => ({
  purposes: (await t.db.select().from(routingPurposeModels)).length,
  catalog: (await t.db.select().from(routingCatalog)).length,
});

describe('发布时装路由两层（runRoutingApply）', () => {
  it('目录装完之后装仓里的骨架：每个用途、每个模型都写进去，摘要写明补了几行；再装一次说已齐、一行不动', async () => {
    await loadCatalog(t.db, example());
    const cfg = await loadRoutingConfig();
    const purposeRows = STAGE_KINDS.reduce(
      (n, s) => n + (cfg.purposes[s] ?? cfg.purposes.default ?? []).length,
      0,
    );
    const catalogRows = Object.values(cfg.models).reduce((n, rs) => n + rs.length, 0);

    const first = await runRoutingApply(t.db);
    expect(first).toContain(`补了用途 → 模型 ${purposeRows} 行（${STAGE_KINDS.length} 个用途：`);
    expect(first).toContain(`补了模型 → 路由 ${catalogRows} 行（${Object.keys(cfg.models).length} 个模型：`);
    expect(await rows()).toEqual({ purposes: purposeRows, catalog: catalogRows });

    const again = await runRoutingApply(t.db);
    expect(again).toBe(
      `路由两层已齐，这次一行没改；库里已有、没动的：用途 ${STAGE_KINDS.length} 个、模型 ${Object.keys(cfg.models).length} 个（驾驶舱改过的不覆盖）`,
    );
    expect(await rows()).toEqual({ purposes: purposeRows, catalog: catalogRows });
  });

  it('【故意造出的失败】骨架文件读不到：抛 RoutingConfigError，库里一行不写（不当成空骨架）', async () => {
    await loadCatalog(t.db, example());
    const err = await runRoutingApply(t.db, new URL('./不在这里.json', ROUTING_DEFAULT_PATH)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect(String((err as Error).message)).toContain('读不到路由配置');
    expect(await rows()).toEqual({ purposes: 0, catalog: 0 });
  });

  it('【故意造出的失败】目录还没装（骨架里的路由库里没有）：抛错并点名哪几条，库里一行不写', async () => {
    const err = await runRoutingApply(t.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoutingConfigError);
    const problems = (err as RoutingConfigError).problems.join('\n');
    expect(problems).toContain('路由 claude-solo:opus-5.5:claude-code 库里没有');
    expect(problems).toContain('模型 jev-1.13 库里没有');
    expect(await rows()).toEqual({ purposes: 0, catalog: 0 });
  });

  it('摘要：只补了一层就只说那一层；保持的个数照写', () => {
    expect(
      formatRoutingApplyReport({
        purposesApplied: [],
        modelsApplied: ['grok-4.7'],
        purposesKept: ['execute'],
        modelsKept: ['opus-5.5', 'jev-1.13'],
        purposeRowsInserted: 0,
        catalogRowsInserted: 1,
      }),
    ).toBe(
      [
        '补了模型 → 路由 1 行（1 个模型：grok-4.7）',
        '库里已有、没动的：用途 1 个、模型 2 个（驾驶舱改过的不覆盖）',
      ].join('\n'),
    );
  });
});
