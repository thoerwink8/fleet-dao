// 渠道模型名册（#1302）：记下看见的模型，跟目录比出差集。读失败不改旧记录，也不把差集说成对得上。
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.ts';
import {
  catalogModelStrings,
  channelModelDiff,
  MODEL_ROSTER_CHANNELS,
  MODEL_ROSTER_EVERY_MS,
  modelRosterDue,
  normalizeChannelModelRead,
  saveChannelModelReads,
} from '../src/queries/channel-models.ts';
import {
  channelModelReads,
  channelSeenModels,
  channels,
  families,
  models,
  pools,
  routes,
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

  it('新增的留下，消失的路由列出来；别名算对得上，方括号不剥，没写上游串不算对得上', async () => {
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
    expect(first.missingFromCatalog.map((m) => `${m.channelId}:${m.modelKey}`).sort()).toEqual([
      'claude-sub:claude-new',
      'cursor:composer-2.5',
      'mirasim:kimi-k3',
    ]);
    expect(first.goneRoutes.map((r) => r.routeId)).toEqual(['rt-bare']);
    expect(first.goneRoutes[0]?.upstreamModel).toBe('');
    const claudeNew = first.missingFromCatalog.find((m) => m.modelKey === 'claude-new');
    expect(claudeNew?.channelName).toBe('Claude 订阅');
    expect(claudeNew?.firstSeenAt).toBe(NOW.toISOString());

    await saveChannelModelReads(t.db, [ok('claude-sub', ['claude-new'])], LATER);
    const second = await channelModelDiff(t.db);
    expect(second.missingFromCatalog.some((m) => m.modelKey === 'claude-sonnet-5-5')).toBe(false);
    expect(second.missingFromCatalog.find((m) => m.modelKey === 'claude-new')?.firstSeenAt).toBe(
      NOW.toISOString(),
    );
    expect(second.missingFromCatalog.find((m) => m.modelKey === 'claude-new')?.lastSeenAt).toBe(
      LATER.toISOString(),
    );
    expect(second.goneRoutes.map((r) => r.routeId).sort()).toEqual(['rt-bare', 'rt-sonnet']);
    const seen = await t.db.select().from(channelSeenModels);
    const sonnet = seen.find((r) => r.modelKey === 'claude-sonnet-5-5');
    expect(sonnet?.lastSeenAt.toISOString()).toBe(NOW.toISOString());
    expect(sonnet?.firstSeenAt.toISOString()).toBe(NOW.toISOString());
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

  it('跟名册比基名时，目录串含模型编号、上游串和别名', async () => {
    await seedChannels(t.db);
    const strings = await catalogModelStrings(t.db);
    expect(strings).toEqual(
      expect.arrayContaining([
        'sonnet',
        'grok',
        'bare',
        'claude-sonnet-5-5',
        'grok-4.7[context=256k]',
        'grok-4.7',
      ]),
    );
    expect(strings).not.toContain('');
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
});
