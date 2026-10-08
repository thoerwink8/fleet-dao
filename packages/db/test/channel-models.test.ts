// 渠道模型名册（#1302）：记下看见的模型，跟目录比出差集。读失败不改旧记录，也不把差集说成对得上。
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.ts';
import {
  channelModelDiff,
  MODEL_ROSTER_CHANNELS,
  MODEL_ROSTER_EVERY_MS,
  modelRosterDue,
  normalizeChannelModelRead,
  registerManualModel,
  revokeManualModel,
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
    const claude = MODEL_ROSTER_CHANNELS.find((c) => c.channelId === 'claude-sub');
    expect(claude && 'manual' in claude && claude.manual).toBe(true);
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
        ok('xai', ['grok-4.7', 'grok-new']),
        ok('cursor', ['composer-2.5']),
        ok('mirasim', ['kimi-k3']),
      ],
      NOW,
    );
    const first = await channelModelDiff(t.db);
    expect(first.failed).toEqual([]);
    expect(first.notYet).toEqual([]);
    expect(first.manual).toEqual([{ channelId: 'claude-sub', channelName: 'Claude 订阅', count: 0 }]);
    expect(first.missingFromCatalog.some((m) => m.channelId === 'claude-sub')).toBe(false);
    expect(first.missingFromCatalog.map((m) => `${m.channelId}:${m.modelKey}`).sort()).toEqual([
      'cursor:composer-2.5',
      'mirasim:kimi-k3',
      'xai:grok-new',
    ]);
    expect(first.goneRoutes.map((r) => r.routeId)).toEqual(['rt-bare']);
    expect(first.goneRoutes[0]?.upstreamModel).toBe('');
    const grokNew = first.missingFromCatalog.find((m) => m.modelKey === 'grok-new');
    expect(grokNew?.channelName).toBe('Grok 订阅');
    expect(grokNew?.firstSeenAt).toBe(NOW.toISOString());

    await saveChannelModelReads(t.db, [ok('xai', ['grok-new'])], LATER);
    const second = await channelModelDiff(t.db);
    expect(second.missingFromCatalog.some((m) => m.modelKey === 'grok-4.7')).toBe(false);
    expect(second.missingFromCatalog.find((m) => m.modelKey === 'grok-new')?.firstSeenAt).toBe(
      NOW.toISOString(),
    );
    expect(second.missingFromCatalog.find((m) => m.modelKey === 'grok-new')?.lastSeenAt).toBe(
      LATER.toISOString(),
    );
    expect(second.goneRoutes.map((r) => r.routeId).sort()).toEqual(['rt-bare', 'rt-grok']);
    const seen = await t.db.select().from(channelSeenModels);
    const grok = seen.find((r) => r.modelKey === 'grok-4.7');
    expect(grok?.lastSeenAt.toISOString()).toBe(NOW.toISOString());
    expect(grok?.firstSeenAt.toISOString()).toBe(NOW.toISOString());
    expect(grok?.source).toBe('名册');
    expect(seen.find((r) => r.modelKey === 'claude-new')?.source).toBe('名册');
  });

  it('读不成不改上次看见的，差集里只有失败，不把旧路由说成消失；手工渠道的失败读不算没读成', async () => {
    await seedChannels(t.db);
    await saveChannelModelReads(t.db, [ok('xai', ['grok-4.7', 'grok-new'])], NOW);
    await saveChannelModelReads(t.db, [fail('xai', 'no_credentials', '没有登录')], LATER);
    await saveChannelModelReads(t.db, [fail('claude-sub', 'config', '读不了')], LATER);
    const diff = await channelModelDiff(t.db);
    expect(diff.missingFromCatalog.some((m) => m.channelId === 'xai')).toBe(false);
    expect(diff.goneRoutes.some((r) => r.channelId === 'xai')).toBe(false);
    expect(diff.failed).toEqual([
      { channelId: 'xai', channelName: 'Grok 订阅', code: 'no_credentials', message: '没有登录' },
    ]);
    expect(diff.failed.some((f) => f.channelId === 'claude-sub')).toBe(false);
    expect(diff.notYet.some((n) => n.channelId === 'claude-sub')).toBe(false);
    expect(diff.manual).toEqual([{ channelId: 'claude-sub', channelName: 'Claude 订阅', count: 0 }]);
    const seen = await t.db.select().from(channelSeenModels);
    expect(seen.find((r) => r.modelKey === 'grok-new')?.lastSeenAt.toISOString()).toBe(NOW.toISOString());
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
    expect(diff.notYet.map((c) => c.channelId)).toEqual(['mirasim', 'cursor', 'xai']);
    expect(diff.manual).toEqual([{ channelId: 'claude-sub', channelName: 'Claude 订阅', count: 0 }]);
    expect(diff.goneRoutes.some((r) => r.routeId === 'rt-sonnet')).toBe(false);
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
    await expectViolation(
      t.db.insert(channelSeenModels).values({
        channelId: 'xai',
        modelKey: 'grok-x',
        source: '别处',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      }),
      'channel_seen_models_source_known',
    );
    await expectViolation(
      t.db.update(routes).set({ executor: '   ' }).where(eq(routes.id, 'rt-grok')),
      'routes_executor_nonempty',
    );
  });

  const actor = {
    actorKind: 'user' as const,
    actorId: 'u1',
    via: 'cockpit' as const,
    reason: '补上订阅里的模型',
  };

  it('手工登记进名册、来源记手工、写操作记录；再登一次报错且不再记一条成功', async () => {
    await seedChannels(t.db);
    const first = await registerManualModel(t.db, {
      channelId: 'claude-sub',
      modelKey: ' claude-opus-5-5 ',
      now: NOW,
      ...actor,
    });
    expect(first).toEqual({
      channelId: 'claude-sub',
      modelKey: 'claude-opus-5-5',
      source: '手工',
      count: 1,
    });
    const seen = await t.db.select().from(channelSeenModels);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ modelKey: 'claude-opus-5-5', source: '手工' });
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'model-roster.register',
      target: 'channel:claude-sub',
      actorKind: 'user',
      actorId: 'u1',
      via: 'cockpit',
      ok: true,
    });
    await expect(
      registerManualModel(t.db, {
        channelId: 'claude-sub',
        modelKey: 'claude-opus-5-5',
        now: LATER,
        ...actor,
      }),
    ).rejects.toMatchObject({ code: 'already_registered' });
    expect(await t.db.select().from(auditLog)).toHaveLength(1);

    await saveChannelModelReads(t.db, [ok('claude-sub', ['claude-opus-5-5'])], LATER);
    const kept = (await t.db.select().from(channelSeenModels)).find((r) => r.modelKey === 'claude-opus-5-5');
    expect(kept?.source).toBe('手工');
    expect(kept?.lastSeenAt.toISOString()).toBe(LATER.toISOString());
  });

  it('撤销只删手工登记的串，不删目录里的路由；空串、有名册的渠道、撤名册行都报错', async () => {
    await seedChannels(t.db);
    await registerManualModel(t.db, { channelId: 'claude-sub', modelKey: 'claude-new', now: NOW, ...actor });
    const gone = await revokeManualModel(t.db, {
      channelId: 'claude-sub',
      modelKey: 'claude-new',
      now: LATER,
      ...actor,
    });
    expect(gone).toEqual({ channelId: 'claude-sub', modelKey: 'claude-new', source: '手工', count: 0 });
    expect(await t.db.select().from(channelSeenModels)).toEqual([]);
    const left = await t.db.select().from(routes);
    expect(left.map((r) => r.id)).toContain('rt-sonnet');
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action).sort()).toEqual(['model-roster.register', 'model-roster.revoke']);

    await expect(
      registerManualModel(t.db, { channelId: 'claude-sub', modelKey: '   ', now: NOW, ...actor }),
    ).rejects.toMatchObject({ code: 'empty_model' });
    await expect(
      registerManualModel(t.db, { channelId: 'xai', modelKey: 'grok-4', now: NOW, ...actor }),
    ).rejects.toMatchObject({ code: 'not_manual' });
    await expect(
      registerManualModel(t.db, { channelId: 'nope', modelKey: 'x', now: NOW, ...actor }),
    ).rejects.toMatchObject({ code: 'channel_not_found' });
    await expect(
      revokeManualModel(t.db, { channelId: 'claude-sub', modelKey: 'claude-new', now: NOW, ...actor }),
    ).rejects.toMatchObject({ code: 'not_registered' });

    await t.db.insert(channelSeenModels).values({
      channelId: 'claude-sub',
      modelKey: 'claude-sonnet-5-5',
      source: '名册',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    await expect(
      revokeManualModel(t.db, {
        channelId: 'claude-sub',
        modelKey: 'claude-sonnet-5-5',
        now: NOW,
        ...actor,
      }),
    ).rejects.toMatchObject({ code: 'not_hand' });
    await expect(
      registerManualModel(t.db, {
        channelId: 'claude-sub',
        modelKey: 'claude-sonnet-5-5',
        now: NOW,
        ...actor,
      }),
    ).rejects.toMatchObject({ code: 'already_registered' });
  });

  it('登记之后跟读成的名册一样比差集；一个都没登记不把路由说成消失', async () => {
    await seedChannels(t.db);
    const empty = await channelModelDiff(t.db);
    expect(empty.manual).toEqual([{ channelId: 'claude-sub', channelName: 'Claude 订阅', count: 0 }]);
    expect(empty.goneRoutes.some((r) => r.routeId === 'rt-sonnet')).toBe(false);

    await registerManualModel(t.db, { channelId: 'claude-sub', modelKey: 'claude-new', now: NOW, ...actor });
    const diff = await channelModelDiff(t.db);
    expect(diff.manual).toEqual([{ channelId: 'claude-sub', channelName: 'Claude 订阅', count: 1 }]);
    expect(diff.failed.some((f) => f.channelId === 'claude-sub')).toBe(false);
    expect(diff.missingFromCatalog.map((m) => m.modelKey)).toEqual(['claude-new']);
    expect(diff.goneRoutes.map((r) => r.routeId)).toContain('rt-sonnet');
  });

  it('Mirasim 读成后按名册字段或前缀写下执行体；认不出的标执行体未知；读失败不改', async () => {
    await seedChannels(t.db);
    await t.db.insert(models).values([
      { id: 'glm-flash', family: 'fam', displayName: 'GLM' },
      { id: 'ds', family: 'fam', displayName: 'DS' },
      { id: 'mystery', family: 'fam', displayName: 'Mystery' },
      { id: 'kimi', family: 'fam', displayName: 'Kimi' },
    ]);
    await t.db.insert(routes).values([
      {
        id: 'rt-glm',
        channelId: 'mirasim',
        poolId: 'mirasim-relay',
        modelId: 'glm-flash',
        hostId: 'mirasim',
        upstreamModel: 'glm-5.3-flash',
      },
      {
        id: 'rt-ds',
        channelId: 'mirasim',
        poolId: 'mirasim-relay',
        modelId: 'ds',
        hostId: 'mirasim',
        upstreamModel: 'deepseek-flash',
      },
      {
        id: 'rt-mystery',
        channelId: 'mirasim',
        poolId: 'mirasim-relay',
        modelId: 'mystery',
        hostId: 'mirasim',
        upstreamModel: 'glm-6',
      },
      {
        id: 'rt-kimi',
        channelId: 'mirasim',
        poolId: 'mirasim-relay',
        modelId: 'kimi',
        hostId: 'mirasim',
        upstreamModel: 'kimi-k3',
      },
    ]);
    await saveChannelModelReads(
      t.db,
      [
        {
          ok: true,
          channelId: 'mirasim',
          models: ['glm-5.3-flash', 'deepseek-flash', 'glm-6', 'kimi-k3'],
          executors: [
            { modelKey: 'glm-5.3-flash', executor: 'zcode' },
            { modelKey: 'kimi-k3', executor: 'pi' },
            { modelKey: 'kimi-k3', executor: 'kimi' },
          ],
        },
      ],
      NOW,
    );
    const stamped = new Map((await t.db.select().from(routes)).map((r) => [r.id, r.executor]));
    expect(stamped.get('rt-glm')).toBe('zcode');
    expect(stamped.get('rt-ds')).toBe('dsh');
    expect(stamped.get('rt-mystery')).toBe('执行体未知');
    expect(stamped.get('rt-kimi')).toBe('pi');

    await saveChannelModelReads(t.db, [fail('mirasim', 'timeout', '超时')], LATER);
    const after = (await t.db.select().from(routes)).find((r) => r.id === 'rt-mystery');
    expect(after?.executor).toBe('执行体未知');
  });
});
