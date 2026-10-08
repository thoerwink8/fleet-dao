// 路由两层的先后和开关（母单 #1089 第二片）：用途下的模型上移 / 下移、模型下的路由上移 / 下移、路由开关。
// 换位置在一个事务里先挪到临时位置再换，两张表对 (purpose, position)、(model_id, position) 的唯一约束不撞；
// 已在最上 / 最下、没有这一项、别人刚改过（看到的先后对不上）都明确拒、一行不动。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  moveModelRoute,
  movePurposeModel,
  reorderModelRoutes,
  reorderPurposeModels,
  setChannelEnabledFlag,
  setModelEnabled,
  setRouteEnabled,
} from '../src/routing-order.ts';
import { channels, routingCatalog, routingPurposeModels } from '../src/schema/index.ts';
import { createTestDb, realTestPgUrl, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRoute, catalog } from './helpers.ts';

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
  // 同一个模型下三条路由：(账号池, 模型, 执行方式) 不能重
  await addRoute(t.db, { id: 'a', poolId: 'relay-a', modelId: 'opus-4.9' });
  await addRoute(t.db, { id: 'b', poolId: 'relay-b', modelId: 'opus-4.9' });
  await addRoute(t.db, { id: 'c', poolId: 'relay-a', modelId: 'opus-4.9', hostId: 'grok' });
  await t.db.insert(routingCatalog).values(
    ['a', 'b', 'c'].map((routeId, position) => ({
      modelId: 'opus-4.9',
      routeId,
      position,
      enabled: true,
    })),
  );
  await t.db.insert(routingPurposeModels).values([
    { purpose: 'execute', modelId: 'opus-5.5', position: 0 },
    { purpose: 'execute', modelId: 'opus-4.9', position: 1 },
    { purpose: 'execute', modelId: 'gpt-5.6-luna', position: 2 },
    { purpose: 'review', modelId: 'opus-4.9', position: 0 },
    { purpose: 'review', modelId: 'grok-4.7', position: 1 },
  ]);
});

const modelOrder = async (purpose: 'execute' | 'review') =>
  (await t.db.select().from(routingPurposeModels).where(eq(routingPurposeModels.purpose, purpose)))
    .sort((x, y) => x.position - y.position)
    .map((r) => [r.modelId, r.position]);

const routeOrder = async () =>
  (await t.db.select().from(routingCatalog).where(eq(routingCatalog.modelId, 'opus-4.9')))
    .sort((x, y) => x.position - y.position)
    .map((r) => [r.routeId, r.position]);

describe('用途下的模型上移 / 下移', () => {
  it('下移：和下一个换位置，位置还是 0、1、2；别的用途不动', async () => {
    expect(
      await movePurposeModel(t.db, {
        purpose: 'execute',
        modelId: 'opus-5.5',
        direction: 'down',
        expected: ['opus-5.5', 'opus-4.9', 'gpt-5.6-luna'],
      }),
    ).toEqual({
      ok: true,
      before: ['opus-5.5', 'opus-4.9', 'gpt-5.6-luna'],
      after: ['opus-4.9', 'opus-5.5', 'gpt-5.6-luna'],
    });
    expect(await modelOrder('execute')).toEqual([
      ['opus-4.9', 0],
      ['opus-5.5', 1],
      ['gpt-5.6-luna', 2],
    ]);
    expect(await modelOrder('review')).toEqual([
      ['opus-4.9', 0],
      ['grok-4.7', 1],
    ]);
  });

  it('上移：连着上移两次回到最上；不带 expected 就不比', async () => {
    expect(
      await movePurposeModel(t.db, { purpose: 'execute', modelId: 'gpt-5.6-luna', direction: 'up' }),
    ).toMatchObject({ ok: true, after: ['opus-5.5', 'gpt-5.6-luna', 'opus-4.9'] });
    expect(
      await movePurposeModel(t.db, { purpose: 'execute', modelId: 'gpt-5.6-luna', direction: 'up' }),
    ).toMatchObject({ ok: true, after: ['gpt-5.6-luna', 'opus-5.5', 'opus-4.9'] });
    expect(await modelOrder('execute')).toEqual([
      ['gpt-5.6-luna', 0],
      ['opus-5.5', 1],
      ['opus-4.9', 2],
    ]);
  });

  it('位置不连续（空了一格）也照相邻的换：换完两个位置都还是原来占着的那两个', async () => {
    await t.db
      .update(routingPurposeModels)
      .set({ position: 7 })
      .where(eq(routingPurposeModels.modelId, 'gpt-5.6-luna'));
    await movePurposeModel(t.db, { purpose: 'execute', modelId: 'gpt-5.6-luna', direction: 'up' });
    expect(await modelOrder('execute')).toEqual([
      ['opus-5.5', 0],
      ['gpt-5.6-luna', 1],
      ['opus-4.9', 7],
    ]);
  });

  it('【故意造出的失败】已经在最上 / 最下：at_edge，一行不动', async () => {
    expect(
      await movePurposeModel(t.db, { purpose: 'execute', modelId: 'opus-5.5', direction: 'up' }),
    ).toEqual({
      ok: false,
      kind: 'at_edge',
      why: '模型 opus-5.5 已经在用途 execute 的最上面，没处上移了',
    });
    expect(
      await movePurposeModel(t.db, { purpose: 'execute', modelId: 'gpt-5.6-luna', direction: 'down' }),
    ).toMatchObject({ ok: false, kind: 'at_edge' });
    expect((await modelOrder('execute')).map(([id]) => id)).toEqual(['opus-5.5', 'opus-4.9', 'gpt-5.6-luna']);
  });

  it('【故意造出的失败】这个用途下没有这个模型：not_found', async () => {
    expect(
      await movePurposeModel(t.db, { purpose: 'review', modelId: 'opus-5.5', direction: 'down' }),
    ).toEqual({ ok: false, kind: 'not_found', why: '用途 review 下没有模型 opus-5.5' });
  });

  it('【故意造出的失败】别人刚改过（看到的先后对不上）：conflict 带库里现在的先后，不覆盖', async () => {
    await movePurposeModel(t.db, { purpose: 'execute', modelId: 'opus-5.5', direction: 'down' });
    expect(
      await movePurposeModel(t.db, {
        purpose: 'execute',
        modelId: 'opus-5.5',
        direction: 'down',
        expected: ['opus-5.5', 'opus-4.9', 'gpt-5.6-luna'],
      }),
    ).toEqual({ ok: false, kind: 'conflict', current: ['opus-4.9', 'opus-5.5', 'gpt-5.6-luna'] });
    expect((await modelOrder('execute')).map(([id]) => id)).toEqual(['opus-4.9', 'opus-5.5', 'gpt-5.6-luna']);
  });
});

describe('模型下的路由上移 / 下移', () => {
  it('上移、下移：换位置不撞 (model_id, position) 唯一约束；别的模型不动', async () => {
    expect(await moveModelRoute(t.db, { modelId: 'opus-4.9', routeId: 'c', direction: 'up' })).toEqual({
      ok: true,
      before: ['a', 'b', 'c'],
      after: ['a', 'c', 'b'],
    });
    expect(await routeOrder()).toEqual([
      ['a', 0],
      ['c', 1],
      ['b', 2],
    ]);
    expect(
      await moveModelRoute(t.db, {
        modelId: 'opus-4.9',
        routeId: 'a',
        direction: 'down',
        expected: ['a', 'c', 'b'],
      }),
    ).toMatchObject({ ok: true, after: ['c', 'a', 'b'] });
    expect(await routeOrder()).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('开着还是关着、思考档位跟着路由走，不因换位置丢', async () => {
    await t.db
      .update(routingCatalog)
      .set({ enabled: false, effort: 'low' })
      .where(eq(routingCatalog.routeId, 'a'));
    await moveModelRoute(t.db, { modelId: 'opus-4.9', routeId: 'a', direction: 'down' });
    const rows = await t.db.select().from(routingCatalog).where(eq(routingCatalog.routeId, 'a'));
    expect(rows[0]).toMatchObject({ position: 1, enabled: false, effort: 'low' });
  });

  it('【故意造出的失败】已经在最上 / 最下、没有这条路由、看到的先后对不上：都拒，一行不动', async () => {
    expect(await moveModelRoute(t.db, { modelId: 'opus-4.9', routeId: 'a', direction: 'up' })).toMatchObject({
      ok: false,
      kind: 'at_edge',
    });
    expect(
      await moveModelRoute(t.db, { modelId: 'opus-4.9', routeId: 'c', direction: 'down' }),
    ).toMatchObject({
      ok: false,
      kind: 'at_edge',
    });
    expect(await moveModelRoute(t.db, { modelId: 'opus-4.9', routeId: 'nope', direction: 'up' })).toEqual({
      ok: false,
      kind: 'not_found',
      why: '模型 opus-4.9 下没有路由 nope',
    });
    expect(
      await moveModelRoute(t.db, {
        modelId: 'opus-4.9',
        routeId: 'b',
        direction: 'up',
        expected: ['b', 'a', 'c'],
      }),
    ).toEqual({ ok: false, kind: 'conflict', current: ['a', 'b', 'c'] });
    expect(await routeOrder()).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('两个人同时改同一串：后到的等前一个提交，再对 expected，对不上回 conflict（不会两次都「成功」互相覆盖）', async () => {
    const results = await Promise.all([
      moveModelRoute(t.db, {
        modelId: 'opus-4.9',
        routeId: 'a',
        direction: 'down',
        expected: ['a', 'b', 'c'],
      }),
      moveModelRoute(t.db, { modelId: 'opus-4.9', routeId: 'c', direction: 'up', expected: ['a', 'b', 'c'] }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.kind === 'conflict')).toHaveLength(1);
  });

  // 上面那条两个调用谁先拿到锁看运气，真库里只在「后到的恰好在前一个提交之前开始等」时才露出乱序（CI 上偶发红过两次）。
  // 这一条把那个时序钉死：A 改完先不提交，等 B 确实卡在锁上，再让 A 提交。PGlite 只有一条连接，造不出两个事务同时等锁，只在真 Postgres 下跑。
  it.skipIf(realTestPgUrl() === undefined)(
    '后到的已经卡在锁上才等到前一个提交：读到的是提交后的先后，回 conflict',
    async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let moved!: () => void;
      const aMoved = new Promise<void>((resolve) => {
        moved = resolve;
      });
      const a = t.db.transaction(async (tx) => {
        const result = await moveModelRoute(tx, {
          modelId: 'opus-4.9',
          routeId: 'a',
          direction: 'down',
          expected: ['a', 'b', 'c'],
        });
        moved();
        await gate; // 提交前一直握着锁
        return result;
      });
      await aMoved;
      const b = moveModelRoute(t.db, {
        modelId: 'opus-4.9',
        routeId: 'c',
        direction: 'up',
        expected: ['a', 'b', 'c'],
      });
      // 等 B 真的卡在行锁上（不是睡一觉赌它到了）
      for (let i = 0; ; i++) {
        const { rows } = await t.client.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if ((rows[0]?.n ?? 0) > 0) break;
        if (i >= 200) throw new Error('B 一直没卡在锁上：这条用例造不出要测的时序');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra).toMatchObject({ ok: true, after: ['b', 'a', 'c'] });
      expect(rb).toEqual({ ok: false, kind: 'conflict', current: ['b', 'a', 'c'] });
      expect(await routeOrder()).toEqual([
        ['b', 0],
        ['a', 1],
        ['c', 2],
      ]);
    },
  );
});

describe('拖到新位置', () => {
  const before = ['opus-5.5', 'opus-4.9', 'gpt-5.6-luna'];

  it('整段重排：位置从 0 连续排；别的用途里的同一个模型不动', async () => {
    const order = ['gpt-5.6-luna', 'opus-5.5', 'opus-4.9'];
    expect(
      await reorderPurposeModels(t.db, {
        purpose: 'execute',
        modelId: 'opus-5.5',
        expected: before,
        order,
      }),
    ).toEqual({ ok: true, before, after: order });
    expect(await modelOrder('execute')).toEqual(order.map((id, position) => [id, position]));
    expect(await modelOrder('review')).toEqual([
      ['opus-4.9', 0],
      ['grok-4.7', 1],
    ]);
  });

  it('【故意造出的失败】不是现在这一串的重排、看到的先后过期：一行不动', async () => {
    expect(
      await reorderPurposeModels(t.db, {
        purpose: 'execute',
        modelId: 'opus-5.5',
        expected: before,
        order: ['opus-5.5', 'opus-5.5', 'opus-4.9'],
      }),
    ).toMatchObject({ ok: false, kind: 'invalid' });
    expect(
      await reorderModelRoutes(t.db, {
        modelId: 'opus-4.9',
        routeId: 'c',
        expected: ['a', 'b', 'c'],
        order: ['c', 'a', 'b'],
      }),
    ).toEqual({ ok: true, before: ['a', 'b', 'c'], after: ['c', 'a', 'b'] });
    await movePurposeModel(t.db, { purpose: 'execute', modelId: 'opus-5.5', direction: 'down' });
    expect(
      await reorderPurposeModels(t.db, {
        purpose: 'execute',
        modelId: 'opus-5.5',
        expected: before,
        order: ['gpt-5.6-luna', 'opus-4.9', 'opus-5.5'],
      }),
    ).toMatchObject({ ok: false, kind: 'conflict' });
    expect(await routeOrder()).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });
});

describe('模型开关、渠道开关', () => {
  it('关掉模型：这个模型下的路由全部关掉，先后不动；看到的开着的路由对不上就不覆盖', async () => {
    expect(
      await setModelEnabled(t.db, {
        modelId: 'opus-4.9',
        enabled: false,
        expectedEnabled: ['a', 'b', 'c'],
      }),
    ).toEqual({ ok: true, before: ['a', 'b', 'c'], after: [] });
    expect(
      (await t.db.select().from(routingCatalog).where(eq(routingCatalog.modelId, 'opus-4.9')))
        .sort((x, y) => x.position - y.position)
        .map((r) => [r.routeId, r.enabled, r.position]),
    ).toEqual([
      ['a', false, 0],
      ['b', false, 1],
      ['c', false, 2],
    ]);
    expect(
      await setModelEnabled(t.db, {
        modelId: 'opus-4.9',
        enabled: true,
        expectedEnabled: ['a'],
      }),
    ).toEqual({ ok: false, kind: 'conflict', current: [] });
    expect(
      await setModelEnabled(t.db, { modelId: 'opus-4.9', enabled: true, expectedEnabled: [] }),
    ).toMatchObject({ ok: true, after: ['a', 'b', 'c'] });
    expect(await setModelEnabled(t.db, { modelId: 'nope', enabled: false, expectedEnabled: [] })).toEqual({
      ok: false,
      kind: 'not_found',
      why: '模型 nope 下没有路由（路由两层里没挂）',
    });
  });

  it('关掉渠道：只改 channels.enabled；看到的开关对不上就不覆盖', async () => {
    expect(await setChannelEnabledFlag(t.db, { channelId: 'relay', enabled: false, expected: true })).toEqual(
      { ok: true, before: true, after: false },
    );
    expect((await t.db.select().from(channels).where(eq(channels.id, 'relay')))[0]?.enabled).toBe(false);
    expect(await setChannelEnabledFlag(t.db, { channelId: 'relay', enabled: true, expected: true })).toEqual({
      ok: false,
      kind: 'conflict',
      current: false,
    });
    expect(await setChannelEnabledFlag(t.db, { channelId: 'nope', enabled: false, expected: true })).toEqual({
      ok: false,
      kind: 'not_found',
      why: '没有这个渠道：nope',
    });
  });
});

describe('路由开关', () => {
  it('关、再开：回改之前和改之后；先后不动', async () => {
    expect(
      await setRouteEnabled(t.db, { modelId: 'opus-4.9', routeId: 'b', enabled: false, expected: true }),
    ).toEqual({ ok: true, before: true, after: false });
    expect(
      (await t.db.select().from(routingCatalog).where(eq(routingCatalog.routeId, 'b')))[0],
    ).toMatchObject({
      enabled: false,
      position: 1,
    });
    expect(await setRouteEnabled(t.db, { modelId: 'opus-4.9', routeId: 'b', enabled: true })).toEqual({
      ok: true,
      before: false,
      after: true,
    });
  });

  it('【故意造出的失败】没有这条路由、别人刚改过：not_found / conflict，不新建一行、不覆盖', async () => {
    expect(await setRouteEnabled(t.db, { modelId: 'opus-4.9', routeId: 'nope', enabled: false })).toEqual({
      ok: false,
      kind: 'not_found',
      why: '模型 opus-4.9 下没有路由 nope（路由两层里没挂）',
    });
    await setRouteEnabled(t.db, { modelId: 'opus-4.9', routeId: 'a', enabled: false });
    expect(
      await setRouteEnabled(t.db, { modelId: 'opus-4.9', routeId: 'a', enabled: false, expected: true }),
    ).toEqual({ ok: false, kind: 'conflict', current: false });
    expect((await t.db.select().from(routingCatalog)).length).toBe(3);
  });
});
