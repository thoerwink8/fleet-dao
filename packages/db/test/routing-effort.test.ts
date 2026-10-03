// 改一条路由的思考档位（#470，setRoutingEffort）：驾驶舱「改档位」写库的那一步。改了照存、清掉回到没配；
// 这家不认的、认不出的、方括号里写死了的、路由两层里没挂的、别人刚改过的，都明确拒、一行不写。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setRoutingEffort } from '../src/routing-effort.ts';
import { routingCatalog } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
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
  await addRoute(t.db, {
    id: 'claude',
    poolId: 'relay-a',
    modelId: 'opus-4.9',
    upstreamModel: 'claude-opus-4-9',
  });
  await addRoute(t.db, {
    id: 'grok',
    poolId: 'relay-b',
    modelId: 'opus-4.9',
    hostId: 'grok',
    upstreamModel: 'grok-4.7',
  });
  await addRoute(t.db, {
    id: 'cursor-whole',
    poolId: 'relay-a',
    modelId: 'opus-4.9',
    hostId: 'cursor-agent',
    upstreamModel: 'gpt-5.6-luna-high',
  });
  await addRoute(t.db, {
    id: 'cursor-bracket',
    poolId: 'relay-b',
    modelId: 'opus-4.9',
    hostId: 'cursor-agent',
    upstreamModel: 'composer-2.5[fast=true]',
  });
  await t.db.insert(routingCatalog).values(
    ['claude', 'grok', 'cursor-whole', 'cursor-bracket'].map((routeId, position) => ({
      modelId: 'opus-4.9',
      routeId,
      position,
      enabled: true,
    })),
  );
});

const efforts = async () =>
  Object.fromEntries((await t.db.select().from(routingCatalog)).map((r) => [r.routeId, r.effort]));

describe('改档位', () => {
  it('改了照存，回改之前和改之后；清掉（null）回到没配', async () => {
    expect(await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'claude', effort: 'max' })).toEqual({
      ok: true,
      before: null,
      after: 'max',
    });
    expect(await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'grok', effort: 'medium' })).toEqual({
      ok: true,
      before: null,
      after: 'medium',
    });
    // cursor 的方括号模型串：档位补进方括号，能配
    expect(
      await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'cursor-bracket', effort: 'low' }),
    ).toEqual({ ok: true, before: null, after: 'low' });
    expect(
      await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'claude', effort: null, expected: 'max' }),
    ).toEqual({ ok: true, before: 'max', after: null });
    expect(await efforts()).toEqual({
      claude: null,
      grok: 'medium',
      'cursor-whole': null,
      'cursor-bracket': 'low',
    });
  });

  it('【故意造出的失败】这条路由的执行方式不认、认不出、模型串里写死了：回原因，一行不写', async () => {
    expect(await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'grok', effort: 'max' })).toEqual({
      ok: false,
      kind: 'invalid',
      why: 'grok 不支持思考档位（effort）max（只认 low / medium / high / xhigh）',
    });
    expect(await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'claude', effort: 'turbo' })).toEqual(
      {
        ok: false,
        kind: 'invalid',
        why: '思考档位（effort）不认识："turbo"（只有 low / medium / high / xhigh / max）',
      },
    );
    expect(
      await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'cursor-whole', effort: 'high' }),
    ).toMatchObject({
      ok: false,
      kind: 'invalid',
      why: expect.stringContaining('模型串 gpt-5.6-luna-high 不带方括号'),
    });
    expect(await efforts()).toEqual({
      claude: null,
      grok: null,
      'cursor-whole': null,
      'cursor-bracket': null,
    });
  });

  it('【故意造出的失败】路由两层里没挂这条路由：not_found，不新建一行', async () => {
    expect(await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'nope', effort: 'high' })).toEqual({
      ok: false,
      kind: 'not_found',
      why: '模型 opus-4.9 下没有路由 nope（路由两层里没挂）',
    });
    expect(
      await setRoutingEffort(t.db, { modelId: 'claude-fable-5.2', routeId: 'claude', effort: 'high' }),
    ).toMatchObject({ ok: false, kind: 'not_found' });
    expect((await t.db.select().from(routingCatalog)).length).toBe(4);
  });

  it('【故意造出的失败】别人刚改过（改之前的值对不上）：conflict 带现在的值，不覆盖', async () => {
    await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'claude', effort: 'xhigh' });
    expect(
      await setRoutingEffort(t.db, { modelId: 'opus-4.9', routeId: 'claude', effort: 'low', expected: null }),
    ).toEqual({ ok: false, kind: 'conflict', current: 'xhigh' });
    expect((await efforts()).claude).toBe('xhigh');
  });
});
