// 渠道模型名册（#1302）：记下看见的模型，跟目录比出差集。读失败不改旧记录，也不把差集说成对得上。
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.ts';
import {
  channelModelDiff,
  MODEL_ROSTER_CHANNELS,
  MODEL_ROSTER_EVERY_MS,
  modelRosterDue,
  normalizeChannelModelRead,
  saveChannelModelReads,
} from '../src/queries/channel-models.ts';
import {
  auditLog,
  channelModelReads,
  channelSeenModels,
  channels,
  families,
  models,
  pools,
  routes,
  routingCatalog,
  routingPurposeModels,
} from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { expectViolation } from './helpers.ts';

const NOW = new Date('2026-10-08T00:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

async function seedChannels(db: Db) {
  await db.insert(families).values({ id: 'fam', displayName: '族', vendor: 'v' });
  await db.insert(channels).values([
    { id: 'mirasim', name: 'Mirasim 中转', billing: 'subscription' },
    { id: 'cursor', name: 'Cursor 订阅', billing: 'subscription' },
    { id: 'xai', name: 'Grok 订阅', billing: 'subscription' },
    { id: 'claude-sub', name: 'Claude 订阅', billing: 'subscription' },
  ]);
  await db.insert(pools).values([
    { id: 'mirasim-relay', channelId: 'mirasim', maxConcurrency: 1 },
    { id: 'cursor', channelId: 'cursor', maxConcurrency: 1 },
    { id: 'grok', channelId: 'xai', maxConcurrency: 1 },
    { id: 'claude-solo', channelId: 'claude-sub', maxConcurrency: 1 },
  ]);
  await db.insert(models).values([
    { id: 'sonnet', family: 'fam', displayName: 'Sonnet' },
    { id: 'grok', family: 'fam', displayName: 'Grok' },
    { id: 'bare', family: 'fam', displayName: '没写上游串' },
  ]);
  await db.insert(routes).values([
    {
      id: 'rt-sonnet',
      channelId: 'claude-sub',
      poolId: 'claude-solo',
      modelId: 'sonnet',
      hostId: 'claude-code',
      upstreamModel: 'claude-sonnet-5-5',
    },
    {
      id: 'rt-grok',
      channelId: 'xai',
      poolId: 'grok',
      modelId: 'grok',
      hostId: 'grok',
      upstreamModel: 'grok-4.7[context=256k]',
      upstreamAliases: ['grok-4.7'],
    },
    {
      id: 'rt-bare',
      channelId: 'cursor',
      poolId: 'cursor',
      modelId: 'bare',
      hostId: 'cursor-agent',
      upstreamModel: null,
      upstreamAliases: [],
    },
  ]);
}

const ok = (channelId: string, models: string[]) => ({ ok: true as const, channelId, models });
const fail = (channelId: string, code: string, message: string) => ({
  ok: false as const,
  channelId,
  error: { code, message },
});

describe('渠道模型名册', () => {
  it('四个渠道编号钉在目录和额度配置上', () => {
    const catalog = JSON.parse(
      readFileSync(new URL('../../../deploy/catalog.json', import.meta.url), 'utf8'),
    ) as {
      channels: { id: string }[];
    };
    const quota = JSON.parse(
      readFileSync(new URL('../../../deploy/quota.json', import.meta.url), 'utf8'),
    ) as {
      pools: { channelId: string; reader: string }[];
    };
    const catalogIds = new Set(catalog.channels.map((c) => c.id));
    for (const row of MODEL_ROSTER_CHANNELS) {
      expect(catalogIds.has(row.channelId)).toBe(true);
      expect(quota.pools.some((p) => p.channelId === row.channelId && p.reader === row.reader)).toBe(true);
    }
    expect(MODEL_ROSTER_CHANNELS.map((c) => c.channelId).sort()).toEqual([
      'claude-sub',
      'cursor',
      'mirasim',
      'xai',
    ]);
  });

  it('空名单写成 bad_response，不当成读成', () => {
    expect(normalizeChannelModelRead(ok('xai', ['  ', '']))).toEqual({
      ok: false,
      channelId: 'xai',
      error: { code: 'bad_response', message: '渠道回了空名单，不当成一个模型都没有' },
    });
  });

  it('读成后同一份名单差集为空；别名算对得上所以不另插，方括号不剥，没写上游串的标下架', async () => {
    await seedChannels(t.db);
    await saveChannelModelReads(
      t.db,
      [
        ok('claude-sub', ['claude-sonnet-5-5', 'claude-new']),
        ok('xai', ['grok-4.7']),
        ok('cursor', ['composer-2.5']),
        ok('mirasim', ['kimi-k3']),
      ],
      NOW,
    );
    const first = await channelModelDiff(t.db);
    expect(first.failed).toEqual([]);
    expect(first.notYet).toEqual([]);
    expect(first.missingFromCatalog).toEqual([]);
    expect(first.goneRoutes).toEqual([]);
    const routeRows = await t.db.select().from(routes);
    expect(routeRows.find((r) => r.id === 'rt-bare')?.goneAt?.toISOString()).toBe(NOW.toISOString());
    const grok = routeRows.find((r) => r.id === 'rt-grok');
    expect(grok?.goneAt).toBeNull();
    expect(grok?.upstreamModel).toBe('grok-4.7[context=256k]');
    expect(routeRows.filter((r) => r.channelId === 'xai')).toHaveLength(1);
    const seenFirst = await t.db.select().from(channelSeenModels);
    expect(seenFirst.find((r) => r.modelKey === 'claude-new')?.firstSeenAt.toISOString()).toBe(
      NOW.toISOString(),
    );

    await saveChannelModelReads(t.db, [ok('claude-sub', ['claude-new'])], LATER);
    const second = await channelModelDiff(t.db);
    expect(second.missingFromCatalog).toEqual([]);
    expect(second.goneRoutes).toEqual([]);
    const after = await t.db.select().from(routes);
    expect(after.find((r) => r.id === 'rt-sonnet')?.goneAt?.toISOString()).toBe(LATER.toISOString());
    expect(after.filter((r) => r.upstreamModel === 'claude-new')).toHaveLength(1);
    const seen = await t.db.select().from(channelSeenModels);
    const sonnet = seen.find((r) => r.modelKey === 'claude-sonnet-5-5');
    expect(sonnet?.lastSeenAt.toISOString()).toBe(NOW.toISOString());
    expect(sonnet?.firstSeenAt.toISOString()).toBe(NOW.toISOString());
    expect(seen.find((r) => r.modelKey === 'claude-new')?.lastSeenAt.toISOString()).toBe(LATER.toISOString());
  });

  it('读不成不改上次看见的，差集里只有失败，不把旧路由说成消失', async () => {
    await seedChannels(t.db);
    await saveChannelModelReads(t.db, [ok('claude-sub', ['claude-sonnet-5-5', 'claude-new'])], NOW);
    await saveChannelModelReads(t.db, [fail('claude-sub', 'no_credentials', '没有登录')], LATER);
    const diff = await channelModelDiff(t.db);
    expect(diff.missingFromCatalog.some((m) => m.channelId === 'claude-sub')).toBe(false);
    expect(diff.goneRoutes.some((r) => r.channelId === 'claude-sub')).toBe(false);
    expect(diff.failed).toEqual([
      { channelId: 'claude-sub', channelName: 'Claude 订阅', code: 'no_credentials', message: '没有登录' },
    ]);
    const seen = await t.db.select().from(channelSeenModels);
    expect(seen.find((r) => r.modelKey === 'claude-new')?.lastSeenAt.toISOString()).toBe(NOW.toISOString());
  });

  it('读成却给了空名单：记成 bad_response，不把目录里的路由说成消失', async () => {
    await seedChannels(t.db);
    await saveChannelModelReads(t.db, [ok('xai', ['grok-4.7'])], NOW);
    const saved = await saveChannelModelReads(t.db, [ok('xai', [])], LATER);
    expect(saved.unstored).toEqual([]);
    const diff = await channelModelDiff(t.db);
    expect(diff.goneRoutes.some((r) => r.channelId === 'xai')).toBe(false);
    expect(diff.failed.find((f) => f.channelId === 'xai')?.code).toBe('bad_response');
    const row = await t.db.select().from(channelModelReads);
    expect(row.find((r) => r.channelId === 'xai')?.ok).toBe(false);
  });

  it('还没读过的渠道是 notYet，不把它的路由说成消失', async () => {
    await seedChannels(t.db);
    const diff = await channelModelDiff(t.db);
    expect(diff.missingFromCatalog).toEqual([]);
    expect(diff.goneRoutes).toEqual([]);
    expect(diff.failed).toEqual([]);
    expect(diff.notYet.map((c) => c.channelId)).toEqual(['mirasim', 'cursor', 'xai', 'claude-sub']);
  });

  it('渠道行不在就记不上，不抛', async () => {
    const saved = await saveChannelModelReads(t.db, [ok('mirasim', ['kimi-k3'])], NOW);
    expect(saved.unstored).toHaveLength(1);
    expect(saved.unstored[0]?.channelId).toBe('mirasim');
    const diff = await channelModelDiff(t.db);
    expect(diff.notYet.map((c) => c.channelId)).toContain('mirasim');
    expect(diff.missingFromCatalog).toEqual([]);
  });

  it('六个小时到了才再读；四个里缺一个也到点', async () => {
    await seedChannels(t.db);
    expect(await modelRosterDue(t.db, NOW)).toBe(true);
    await saveChannelModelReads(
      t.db,
      MODEL_ROSTER_CHANNELS.map((c) => ok(c.channelId, ['kept'])),
      NOW,
    );
    expect(await modelRosterDue(t.db, new Date(NOW.getTime() + MODEL_ROSTER_EVERY_MS - 1))).toBe(false);
    expect(await modelRosterDue(t.db, new Date(NOW.getTime() + MODEL_ROSTER_EVERY_MS))).toBe(true);
    await saveChannelModelReads(t.db, [fail('cursor', 'auth', '要重新登录')], NOW);
    expect(await modelRosterDue(t.db, new Date(NOW.getTime() + 60_000))).toBe(false);
  });

  it('空模型串、最近看见早于第一次、读成却带着错误，写不进去', async () => {
    await seedChannels(t.db);
    await expectViolation(
      t.db.insert(channelSeenModels).values({
        channelId: 'xai',
        modelKey: '   ',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      }),
      'channel_seen_models_key_nonempty',
    );
    await expectViolation(
      t.db.insert(channelSeenModels).values({
        channelId: 'xai',
        modelKey: 'grok-4.7',
        firstSeenAt: LATER,
        lastSeenAt: NOW,
      }),
      'channel_seen_models_last_after_first',
    );
    await expectViolation(
      t.db.insert(channelModelReads).values({
        channelId: 'xai',
        attemptedAt: NOW,
        ok: true,
        errorCode: 'bad_response',
        errorMessage: '不该有',
      }),
      'channel_model_reads_error_matches_ok',
    );
    await expectViolation(
      t.db.insert(channelModelReads).values({
        channelId: 'cursor',
        attemptedAt: NOW,
        ok: false,
        errorCode: null,
        errorMessage: null,
      }),
      'channel_model_reads_error_matches_ok',
    );
  });

  it('新串入库且关着，不进任何用途', async () => {
    await seedChannels(t.db);
    const saved = await saveChannelModelReads(
      t.db,
      [ok('cursor', ['claude-opus-4-8-thinking-high-fast', 'claude-opus-4-8-thinking-high'])],
      NOW,
    );
    expect(saved.unstored).toEqual([]);
    expect(saved.newModelIds).toEqual(['opus-4.8']);
    const routeRows = await t.db.select().from(routes);
    const fast = routeRows.find((r) => r.upstreamModel === 'claude-opus-4-8-thinking-high-fast');
    const high = routeRows.find((r) => r.upstreamModel === 'claude-opus-4-8-thinking-high');
    expect(fast).toMatchObject({
      channelId: 'cursor',
      poolId: 'cursor',
      modelId: 'opus-4.8',
      hostId: 'cursor-agent',
      alive: false,
      variantEffort: 'high',
      variantFast: true,
      variantThinking: true,
      variantContext: null,
      goneAt: null,
    });
    expect(high).toMatchObject({
      modelId: 'opus-4.8',
      variantEffort: 'high',
      variantFast: false,
      variantThinking: true,
      variantContext: null,
    });
    const catalog = (await t.db.select().from(routingCatalog)).filter((r) => r.modelId === 'opus-4.8');
    expect(catalog.map((r) => r.enabled)).toEqual([false, false]);
    expect(catalog.map((r) => r.position).sort()).toEqual([0, 1]);
    expect(catalog.map((r) => r.effort)).toEqual([null, null]);
    expect((await t.db.select().from(routingPurposeModels)).filter((r) => r.modelId === 'opus-4.8')).toEqual(
      [],
    );

    await saveChannelModelReads(
      t.db,
      [ok('cursor', ['claude-opus-4-8-thinking-high-fast', 'claude-opus-4-8-thinking-high'])],
      LATER,
    );
    expect(await t.db.select().from(routes)).toHaveLength(routeRows.length);
  });

  it('拆不出的进未归类，模型 id 是渠道加原串', async () => {
    await seedChannels(t.db);
    await saveChannelModelReads(t.db, [ok('cursor', ['totally-unknown-model'])], NOW);
    const fam = (await t.db.select().from(families)).find((f) => f.id === 'unclassified');
    expect(fam).toMatchObject({ displayName: '未归类', vendor: '未知' });
    const model = (await t.db.select().from(models)).find((m) => m.id === 'cursor:totally-unknown-model');
    expect(model).toMatchObject({ family: 'unclassified', displayName: 'totally-unknown-model' });
    const route = (await t.db.select().from(routes)).find((r) => r.upstreamModel === 'totally-unknown-model');
    expect(route).toMatchObject({
      modelId: 'cursor:totally-unknown-model',
      variantEffort: null,
      variantFast: null,
      variantThinking: null,
      variantContext: null,
    });
    const catalog = (await t.db.select().from(routingCatalog)).find((r) => r.routeId === route?.id);
    expect(catalog).toMatchObject({ enabled: false, modelId: 'cursor:totally-unknown-model' });
  });

  it('渠道不再列出的路由标下架，不删；再次出现就清掉标记', async () => {
    await seedChannels(t.db);
    await saveChannelModelReads(t.db, [ok('mirasim', ['kimi-k3', 'claude-opus-5-5[1m]'])], NOW);
    let rows = await t.db.select().from(routes);
    const opus = rows.find((r) => r.upstreamModel === 'claude-opus-5-5[1m]');
    expect(opus?.goneAt).toBeNull();
    expect(opus?.id).toBeTruthy();

    await saveChannelModelReads(t.db, [ok('mirasim', ['kimi-k3'])], LATER);
    rows = await t.db.select().from(routes);
    expect(rows.find((r) => r.id === opus?.id)?.goneAt?.toISOString()).toBe(LATER.toISOString());
    expect(rows.find((r) => r.id === opus?.id)?.upstreamModel).toBe('claude-opus-5-5[1m]');
    const diff = await channelModelDiff(t.db);
    expect(diff.missingFromCatalog.filter((m) => m.channelId === 'mirasim')).toEqual([]);
    expect(diff.goneRoutes.filter((r) => r.channelId === 'mirasim')).toEqual([]);

    const back = new Date(LATER.getTime() + 60_000);
    await saveChannelModelReads(t.db, [ok('mirasim', ['kimi-k3', 'claude-opus-5-5[1m]'])], back);
    rows = await t.db.select().from(routes);
    expect(rows.find((r) => r.id === opus?.id)?.goneAt).toBeNull();
    expect(rows.filter((r) => r.upstreamModel === 'claude-opus-5-5[1m]')).toHaveLength(1);
  });

  it('读失败不动任何目录行，也不写自动入库的操作记录', async () => {
    await seedChannels(t.db);
    await saveChannelModelReads(t.db, [ok('cursor', ['composer-2.5'])], NOW);
    const beforeRoutes = await t.db.select().from(routes);
    const beforeModels = await t.db.select().from(models);
    const beforeCatalog = await t.db.select().from(routingCatalog);
    const discovers = async () =>
      (await t.db.select().from(auditLog)).filter((r) => r.action === 'catalog.discover');
    expect(await discovers()).toHaveLength(1);

    await saveChannelModelReads(t.db, [fail('cursor', 'auth', '要重新登录')], LATER);
    expect(await t.db.select().from(routes)).toEqual(beforeRoutes);
    expect(await t.db.select().from(models)).toEqual(beforeModels);
    expect(await t.db.select().from(routingCatalog)).toEqual(beforeCatalog);
    expect(await discovers()).toHaveLength(1);

    await saveChannelModelReads(t.db, [ok('cursor', [])], LATER);
    expect(await t.db.select().from(routes)).toEqual(beforeRoutes);
    expect(await discovers()).toHaveLength(1);
    expect((await t.db.select().from(routes)).find((r) => r.id === 'rt-bare')?.goneAt?.toISOString()).toBe(
      NOW.toISOString(),
    );
  });

  it('已经在目录里的模型和路由不改名、不改开关、不补变体', async () => {
    await seedChannels(t.db);
    await t.db.insert(models).values({ id: 'opus-4.8', family: 'fam', displayName: '手写的名字' });
    await t.db.insert(routes).values({
      id: 'rt-opus',
      channelId: 'cursor',
      poolId: 'cursor',
      modelId: 'opus-4.8',
      hostId: 'cursor-agent',
      upstreamModel: 'claude-opus-4-8-thinking-high',
    });
    await t.db.insert(routingCatalog).values({
      modelId: 'opus-4.8',
      routeId: 'rt-opus',
      position: 0,
      enabled: true,
      effort: 'max',
    });
    const saved = await saveChannelModelReads(
      t.db,
      [ok('cursor', ['claude-opus-4-8-thinking-high', 'claude-opus-4-8-thinking-high-fast'])],
      NOW,
    );
    expect(saved.unstored).toEqual([]);
    const opus = (await t.db.select().from(models)).find((m) => m.id === 'opus-4.8');
    expect(opus).toMatchObject({ displayName: '手写的名字', family: 'fam' });
    const old = (await t.db.select().from(routes)).find((r) => r.id === 'rt-opus');
    expect(old).toMatchObject({
      upstreamModel: 'claude-opus-4-8-thinking-high',
      variantEffort: null,
      variantFast: null,
      variantThinking: null,
      variantContext: null,
      goneAt: null,
      hostId: 'cursor-agent',
      poolId: 'cursor',
    });
    expect((await t.db.select().from(routingCatalog)).find((r) => r.routeId === 'rt-opus')).toMatchObject({
      enabled: true,
      effort: 'max',
      position: 0,
    });
    const created = (await t.db.select().from(routes)).find(
      (r) => r.upstreamModel === 'claude-opus-4-8-thinking-high-fast',
    );
    expect(created).toMatchObject({
      modelId: 'opus-4.8',
      variantEffort: 'high',
      variantFast: true,
      variantThinking: true,
    });
    expect((await t.db.select().from(routingCatalog)).find((r) => r.routeId === created?.id)).toMatchObject({
      enabled: false,
      effort: null,
      position: 1,
    });
  });

  it('每次读成写一条操作记录：新增几个模型、几条路由、标下架几条', async () => {
    await seedChannels(t.db);
    await saveChannelModelReads(t.db, [ok('mirasim', ['claude-opus-5-5[1m]', 'gpt-6-sol'])], NOW);
    const first = await t.db.select().from(auditLog);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      actorKind: 'engine',
      actorId: 'model-roster',
      action: 'catalog.discover',
      target: 'channel:mirasim',
      via: 'engine',
      reason: '名册读成，自动入库',
      ok: true,
      after: { modelsAdded: 2, routesAdded: 2, goneMarked: 0, goneCleared: 0 },
    });
    await saveChannelModelReads(t.db, [ok('mirasim', ['claude-opus-5-5[1m]', 'gpt-6-sol'])], LATER);
    const again = (await t.db.select().from(auditLog)).sort((a, b) => a.id - b.id);
    expect(again).toHaveLength(2);
    expect(again[1]?.after).toEqual({ modelsAdded: 0, routesAdded: 0, goneMarked: 0, goneCleared: 0 });
    expect((await t.db.select().from(routes)).filter((r) => r.channelId === 'mirasim')).toHaveLength(2);
  });

  it('Mirasim 真实名册差集整份入库：grok-4.7 等都拆对，没有一个落进未归类', async () => {
    await seedChannels(t.db);
    const real = JSON.parse(
      readFileSync(new URL('./fixtures/roster-diff-2026-10-08.json', import.meta.url), 'utf8'),
    ) as { mirasimMissing: string[]; grokRoster: string[] };
    const saved = await saveChannelModelReads(
      t.db,
      [
        ok('mirasim', [...real.mirasimMissing, 'grok-4.7', 'grok-4.6', 'grok-4.5']),
        ok('xai', real.grokRoster),
      ],
      NOW,
    );
    expect(saved.unstored).toEqual([]);
    expect(saved.newModelIds).toEqual(
      expect.arrayContaining(['grok-4.7', 'grok-4.6', 'grok-4.5', 'fable-5.1']),
    );
    const unclassified = (await t.db.select().from(models)).filter((m) => m.family === 'unclassified');
    expect(unclassified.map((m) => m.id)).toEqual([]);
    const fable = (await t.db.select().from(routingCatalog)).filter((r) => r.modelId === 'fable-5.1');
    expect(fable.map((r) => r.enabled)).toEqual([false]);
  });

  it('【故意造出的失败】入库后差集里仍有该串则这里红', async () => {
    await seedChannels(t.db);
    const key = 'composer-2.5';
    await saveChannelModelReads(t.db, [ok('cursor', [key])], NOW);
    const diff = await channelModelDiff(t.db);
    expect(diff.missingFromCatalog.filter((m) => m.channelId === 'cursor' && m.modelKey === key)).toEqual([]);
  });
});
