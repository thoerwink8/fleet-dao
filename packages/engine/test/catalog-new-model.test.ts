// 名册读成之后跟目录比基名（#1352）：新家族推一条要人拍，目录补上就撤。不改目录、不开路由。
import type { PoolQuotaResult, QuotaReport } from '@fleet-dao/adapters/quota';
import { alertByKey, type PoolQuotaSnapshot, type ScheduleResult } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChannelModelRosterResult,
  type QuotaReadJobDeps,
  runQuotaReadJob,
} from '../src/jobs/quota-read.ts';
import { quotaReadJob } from '../src/real/quota-read.ts';

const NOW = new Date('2026-10-08T08:00:00Z');
const INFERENCE =
  'Claude 订阅渠道读不了名册，按 Cursor/Mirasim 推断可能也有：补目录时给 claude-solo、claude-carpool 各加一条关着的路由，开之前用路由页「立即探测」验一次';

const quotaOk = (poolId: string): PoolQuotaResult => ({
  ok: true,
  poolId,
  channelId: 'c',
  reader: 'claude-usage',
  startedAt: NOW.toISOString(),
  durationMs: 1,
  notes: [],
  windows: [],
});

const ok = (channelId: string, models: string[]): ChannelModelRosterResult => ({
  ok: true,
  channelId,
  models,
});
const fail = (channelId: string, code: string, message: string): ChannelModelRosterResult => ({
  ok: false,
  channelId,
  error: { code, message },
});

function harness(input: {
  results: ChannelModelRosterResult[];
  catalog: string[];
  openKeys?: string[];
  due?: boolean;
}) {
  const finished: ScheduleResult[] = [];
  const quotaRaised: string[] = [];
  const raised: { key: string; level: string; title: string; body: string }[] = [];
  const resolved: string[] = [];
  const logs: string[] = [];
  let catalogReads = 0;
  const deps: QuotaReadJobDeps = {
    loadConfig: async () => ({ pools: [{ poolId: 'claude-solo' }] }) as never,
    read: async (): Promise<QuotaReport> => ({
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      results: [quotaOk('claude-solo')],
    }),
    save: async (_s: PoolQuotaSnapshot) => undefined,
    lastReadOk: async () => new Map(),
    raise: async (a) => {
      quotaRaised.push(a.key);
    },
    resolve: async () => undefined,
    runs: {
      start: async () => 1,
      finish: async (_id, result) => {
        finished.push(result);
      },
    },
    now: () => NOW,
    log: (level, message) => {
      logs.push(`${level}:${message}`);
    },
    modelRoster: {
      due: async () => input.due ?? true,
      read: async () => input.results,
      save: async () => ({ unstored: [] }),
      catalogStrings: async () => {
        catalogReads += 1;
        return input.catalog;
      },
      openCatalogNewModelKeys: async () => input.openKeys ?? [],
      raiseDecision: async (alert) => {
        raised.push(alert);
      },
      resolveDecision: async (key) => {
        resolved.push(key);
      },
    },
  };
  return { deps, finished, quotaRaised, raised, resolved, logs, catalogReads: () => catalogReads };
}

describe('新模型提醒的接线', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(() => resetTestDb(t));

  it(
    '要人拍写进提醒（decision，链到路由页），撤的时候处理人是引擎；读目录串不起会话',
    async () => {
      let commands = 0;
      const step = quotaReadJob({
        db: t.db,
        modelRoster: {
          commands: { cursor: ['cursor-agent'], grok: ['grok'] },
          runCommand: async () => {
            commands += 1;
            return { code: 0, stdout: '', stderr: '', killed: false };
          },
        },
      })().modelRoster;
      if (
        !step?.raiseDecision ||
        !step.resolveDecision ||
        !step.openCatalogNewModelKeys ||
        !step.catalogStrings
      ) {
        throw new Error('名册接线没接上对目录的差集');
      }
      await step.raiseDecision({
        key: 'catalog-new-model:claude-haiku-9-9',
        level: 'decision',
        title: '目录里还没有 claude-haiku-9-9',
        body: 'cursor 认：claude-haiku-9-9-thinking-high',
      });
      expect(await step.openCatalogNewModelKeys()).toEqual(['catalog-new-model:claude-haiku-9-9']);
      expect(await alertByKey(t.db, 'catalog-new-model:claude-haiku-9-9')).toMatchObject({
        level: 'decision',
        link: '/routing',
        resolvedAt: null,
      });
      await step.resolveDecision('catalog-new-model:claude-haiku-9-9');
      expect(await alertByKey(t.db, 'catalog-new-model:claude-haiku-9-9')).toMatchObject({
        resolvedBy: 'engine',
      });
      expect(await step.openCatalogNewModelKeys()).toEqual([]);
      expect(await step.catalogStrings()).toEqual([]);
      expect(commands).toBe(0);
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('名册对目录的新模型提醒', () => {
  it('Cursor 名册里的新 claude 基名推一条要人拍，正文带订阅渠道的推断', async () => {
    const world = harness({
      catalog: ['claude-haiku-5-5-thinking-high'],
      results: [ok('cursor', ['claude-haiku-9-9-thinking-high']), fail('xai', 'auth', 'Grok 没登录')],
    });
    const run = await runQuotaReadJob(world.deps);
    expect(run.outcome).toBe('ok');
    expect(world.quotaRaised).toEqual([]);
    expect(world.raised).toHaveLength(1);
    const alert = world.raised[0];
    expect(alert?.key).toBe('catalog-new-model:claude-haiku-9-9');
    expect(alert?.level).toBe('decision');
    expect(alert?.title).toContain('claude-haiku-9-9');
    expect(alert?.body).toContain('cursor');
    expect(alert?.body).toContain('claude-haiku-9-9-thinking-high');
    expect(alert?.body).toContain(INFERENCE);
    expect(alert?.body).toContain('渠道模型表没读成');
    expect(alert?.body).toContain('xai');
    expect(alert?.body).toContain('不能当成没有新模型');
    expect(world.resolved).toEqual([]);
  });

  it('同一基名的多个档位、多家渠道只推一条', async () => {
    const world = harness({
      catalog: ['composer-2.5'],
      results: [
        ok('cursor', [
          'claude-haiku-9-9-thinking-high',
          'claude-haiku-9-9-thinking-low',
          'claude-haiku-9-9-fast',
          'claude-haiku-9-9-xhigh',
        ]),
        ok('mirasim', ['claude-haiku-9-9', 'claude-haiku-9-9-thinking-high']),
      ],
    });
    await runQuotaReadJob(world.deps);
    expect(world.raised.map((a) => a.key)).toEqual(['catalog-new-model:claude-haiku-9-9']);
    const body = world.raised[0]?.body ?? '';
    expect(body).toContain('claude-haiku-9-9-thinking-high');
    expect(body).toContain('claude-haiku-9-9-thinking-low');
    expect(body).toContain('claude-haiku-9-9-fast');
    expect(body).toContain('claude-haiku-9-9-xhigh');
    expect(body).toContain('claude-haiku-9-9');
    expect(body).toContain('cursor');
    expect(body).toContain('mirasim');
    expect(body.split(INFERENCE)).toHaveLength(2);
  });

  it('目录补上这个基名后下一轮撤掉，读不成的 Claude 订阅不挡住撤', async () => {
    const world = harness({
      catalog: ['claude-haiku-9-9-thinking-high', 'composer-2.5'],
      openKeys: ['catalog-new-model:claude-haiku-9-9', 'catalog-new-model:still-new'],
      results: [
        ok('cursor', ['claude-haiku-9-9-thinking-low', 'composer-2.5']),
        fail('claude-sub', 'config', 'Claude 命令行没有列模型的只读命令'),
      ],
    });
    await runQuotaReadJob(world.deps);
    expect(world.raised).toEqual([]);
    expect(world.resolved).toEqual(['catalog-new-model:claude-haiku-9-9']);
    expect(world.logs.join('\n')).toContain('渠道模型表没读成');
    expect(world.logs.join('\n')).toContain('claude-sub');
  });

  it('某渠道读失败不推、不撤，并写明哪家没读成', async () => {
    const world = harness({
      catalog: ['composer-2.5'],
      openKeys: ['catalog-new-model:claude-haiku-9-9'],
      results: [fail('cursor', 'timeout', '读模型表超时被停'), ok('mirasim', ['composer-2.5'])],
    });
    await runQuotaReadJob(world.deps);
    expect(world.raised).toEqual([]);
    expect(world.resolved).toEqual([]);
    const text = world.logs.join('\n');
    expect(text).toContain('渠道模型表没读成');
    expect(text).toContain('cursor');
    expect(text).toContain('timeout');
    expect(text).toContain('不能当成没有新模型');
  });

  it('没到读名册的间隔不去对目录', async () => {
    const world = harness({
      due: false,
      catalog: [],
      results: [ok('cursor', ['claude-haiku-9-9-thinking-high'])],
    });
    await runQuotaReadJob(world.deps);
    expect(world.catalogReads()).toBe(0);
    expect(world.raised).toEqual([]);
    expect(world.resolved).toEqual([]);
  });

  it('不是 claude 家族不加订阅推断句，fast 和档位合成一个基名', async () => {
    const world = harness({
      catalog: ['grok-4.7'],
      results: [ok('xai', ['grok-9-fast', 'grok-9-high'])],
    });
    await runQuotaReadJob(world.deps);
    expect(world.raised.map((a) => a.key)).toEqual(['catalog-new-model:grok-9']);
    expect(world.raised[0]?.body).toContain('grok-9-fast');
    expect(world.raised[0]?.body).toContain('grok-9-high');
    expect(world.raised[0]?.body).not.toContain(INFERENCE);
  });

  it('目录已有 grok-4.7 时，名册里的方括号参数不算新模型，旧的带参数键下一轮撤掉', async () => {
    const world = harness({
      catalog: ['grok-4.7'],
      openKeys: ['catalog-new-model:grok-4.7[context=256k]'],
      results: [
        ok('cursor', ['grok-4.7[context=256k]', 'grok-4.7[context=1m,reasoning_effort=high,fast=true]']),
      ],
    });
    await runQuotaReadJob(world.deps);
    expect(world.raised).toEqual([]);
    expect(world.resolved).toEqual(['catalog-new-model:grok-4.7[context=256k]']);
  });

  it('同一家族的不同 context 参数只推一条去掉方括号的基名，正文留原始串', async () => {
    const world = harness({
      catalog: ['composer-2.5[fast=true]'],
      openKeys: ['catalog-new-model:grok-4.7[context=1m]'],
      results: [
        ok('xai', ['grok-4.7[context=256k]', 'grok-4.7[context=1m]']),
        ok('cursor', ['grok-4.7-thinking-high[context=256k]']),
      ],
    });
    await runQuotaReadJob(world.deps);
    expect(world.raised.map((a) => a.key)).toEqual(['catalog-new-model:grok-4.7']);
    const body = world.raised[0]?.body ?? '';
    expect(body).toContain('grok-4.7[context=256k]');
    expect(body).toContain('grok-4.7[context=1m]');
    expect(body).toContain('grok-4.7-thinking-high[context=256k]');
    expect(body).not.toContain(INFERENCE);
    expect(world.resolved).toEqual(['catalog-new-model:grok-4.7[context=1m]']);
  });

  // 故意造出失败：目录里已有同一基名的另一档。再推一条就是错的。这条放最后。
  it('已在目录里的不推', async () => {
    const world = harness({
      catalog: ['claude-haiku-5-5-thinking-high', 'gpt-5.5-high', 'haiku-5.5'],
      openKeys: ['catalog-new-model:claude-haiku-5-5'],
      results: [
        ok('cursor', [
          'claude-haiku-5-5-thinking-low',
          'claude-haiku-5-5',
          'claude-haiku-5-5-thinking-high',
          'gpt-5.5-low',
          'haiku-5.5',
        ]),
      ],
    });
    await runQuotaReadJob(world.deps);
    expect(world.raised).toEqual([]);
    expect(world.resolved).toEqual(['catalog-new-model:claude-haiku-5-5']);
  });
});
