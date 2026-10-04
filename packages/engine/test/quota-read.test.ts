// 定时读额度（#76）：不连库、不连上游，全用假的依赖。规矩见 jobs/quota-read.ts 头注释。
import type { PoolQuotaResult, QuotaConfig, QuotaReading, QuotaReport } from '@fleet-dao/adapters/quota';
import type { PoolQuotaSnapshot, ScheduleResult } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  isCompleteRead,
  poolAlertKey,
  QUOTA_REPEAT_FAIL_MS,
  QuotaReadFailedError,
  type QuotaReadJobDeps,
  runQuotaReadJob,
} from '../src/jobs/quota-read.ts';
import { usageRecordsFrom } from '../src/real/quota-read.ts';

const NOW = new Date('2026-10-03T08:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const window = (poolId: string, label = '5h'): QuotaReading => ({
  poolId,
  window: '5h',
  label,
  unit: 'usd',
  source: 'test',
  reading: 'measured',
  readAt: NOW.toISOString(),
});

const ok = (poolId: string, notes: string[] = []): PoolQuotaResult => ({
  ok: true,
  poolId,
  channelId: 'c',
  reader: 'reclaude-carpool',
  startedAt: NOW.toISOString(),
  durationMs: 10,
  notes,
  windows: [window(poolId)],
});

const failed = (poolId: string, code: string, text = '读不到'): PoolQuotaResult =>
  ({
    ok: false,
    poolId,
    channelId: 'c',
    reader: 'claude-usage',
    startedAt: NOW.toISOString(),
    durationMs: 10,
    notes: [],
    error: { code, message: text },
  }) as PoolQuotaResult;

interface World {
  deps: QuotaReadJobDeps;
  saved: PoolQuotaSnapshot[];
  raised: { key: string; title: string; body: string }[];
  resolved: string[];
  finished: ScheduleResult[];
}

function world(
  results: PoolQuotaResult[],
  over: {
    lastOk?: Record<string, Date | null>;
    loadConfig?: () => Promise<QuotaConfig>;
    read?: () => Promise<QuotaReport>;
  } = {},
): World {
  const saved: PoolQuotaSnapshot[] = [];
  const raised: World['raised'] = [];
  const resolved: string[] = [];
  const finished: ScheduleResult[] = [];
  const config = { pools: results.map((r) => ({ poolId: r.poolId })) } as unknown as QuotaConfig;
  const deps: QuotaReadJobDeps = {
    loadConfig: over.loadConfig ?? (async () => config),
    read:
      over.read ?? (async () => ({ startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), results })),
    save: async (s) => {
      saved.push(s);
    },
    lastReadOk: async (ids) => new Map(ids.map((id) => [id, over.lastOk?.[id] ?? null])),
    raise: async (a) => {
      raised.push(a);
    },
    resolve: async (k) => {
      resolved.push(k);
    },
    runs: {
      start: async () => 7,
      finish: async (_id, r) => {
        finished.push(r);
      },
    },
    now: () => NOW,
    log: () => undefined,
  };
  return { deps, saved, raised, resolved, finished };
}

describe('定时读额度', () => {
  it('读成：写库、撤掉这个池的旧提醒、这一轮记 ok', async () => {
    const w = world([ok('p1'), ok('p2')]);
    const run = await runQuotaReadJob(w.deps);
    expect(w.saved.map((s) => [s.poolId, s.complete])).toEqual([
      ['p1', true],
      ['p2', true],
    ]);
    expect(w.resolved).toEqual(expect.arrayContaining([poolAlertKey('p1'), poolAlertKey('p2')]));
    expect(w.raised).toEqual([]);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 2, found: 0 });
  });

  it('一个池读失败：其余照常写，失败的池什么都不写；上一轮读成过（15 分钟前）只是第一次失败，不报警', async () => {
    const w = world([ok('p1'), failed('p2', 'unreachable')], { lastOk: { p2: minutesAgo(15) } });
    const run = await runQuotaReadJob(w.deps);
    expect(w.saved.map((s) => s.poolId)).toEqual(['p1']);
    expect(w.raised).toEqual([]);
    expect(run.outcome).toBe('partial'); // 没读成不记成 ok
    expect(run.why).toContain('p2 没读成（unreachable）');
  });

  it('连着两轮没读成（最近读成早于两轮之前）：报警，写明上次读成时刻', async () => {
    const w = world([failed('p2', 'upstream', '502')], {
      lastOk: { p2: new Date(NOW.getTime() - QUOTA_REPEAT_FAIL_MS - 60_000) },
    });
    const run = await runQuotaReadJob(w.deps);
    expect(w.raised).toHaveLength(1);
    expect(w.raised[0]).toMatchObject({ key: poolAlertKey('p2') });
    expect(w.raised[0]?.body).toContain('连着两轮没读成');
    expect(run).toMatchObject({ outcome: 'partial', found: 1 });
  });

  it('从没读成过的池读失败：报警（不拿「没有记录」当没事）', async () => {
    const w = world([failed('p3', 'timeout')]);
    await runQuotaReadJob(w.deps);
    expect(w.raised[0]?.body).toContain('从没读成过');
  });

  it('凭据、登录、配置这类要人动手的：第一次就当场报', async () => {
    for (const code of ['no_credentials', 'auth', 'config']) {
      const w = world([failed('p4', code)], { lastOk: { p4: minutesAgo(15) } });
      await runQuotaReadJob(w.deps);
      expect(w.raised, code).toHaveLength(1);
      expect(w.raised[0]?.body).toContain('要人动手');
    }
  });

  it('「当前没挂着这个组织」不报警，也不写库，但这一轮记 partial 写明是哪几个池', async () => {
    const w = world([ok('p1'), failed('solo', 'not_current')]);
    const run = await runQuotaReadJob(w.deps);
    expect(w.raised).toEqual([]);
    expect(w.saved.map((s) => s.poolId)).toEqual(['p1']);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('solo 当前没挂着这个组织');
  });

  it('读取器丢过窗口（notes 里有「没收」）：只写收到的，不算读全（complete=false）', async () => {
    const r = ok('p1', ['窗口 x 名字重复，没收']);
    expect(isCompleteRead(r as Extract<PoolQuotaResult, { ok: true }>)).toBe(false);
    const w = world([r]);
    const run = await runQuotaReadJob(w.deps);
    expect(w.saved[0]?.complete).toBe(false);
    expect(run.outcome).toBe('partial');
  });

  it('【故意造出的失败】配置读不到：当场报、这一轮记 failed 并抛，什么都不读不写', async () => {
    const w = world([], {
      loadConfig: async () => {
        throw new Error('quota.json 不存在');
      },
    });
    await expect(runQuotaReadJob(w.deps)).rejects.toBeInstanceOf(QuotaReadFailedError);
    expect(w.raised[0]?.key).toBe('quota-read:config');
    expect(w.saved).toEqual([]);
    expect(w.finished[0]).toMatchObject({ outcome: 'failed' });
  });

  it('【故意造出的失败】整轮读抛了：记 failed 并抛，不当成读成', async () => {
    const w = world([ok('p1')], {
      read: async () => {
        throw new Error('连不上');
      },
    });
    await expect(runQuotaReadJob(w.deps)).rejects.toThrow(/连不上/);
    expect(w.saved).toEqual([]);
    expect(w.finished[0]).toMatchObject({ outcome: 'failed' });
  });

  it('配置里一个池都没有：记 unscanned，不记成 ok', async () => {
    const w = world([]);
    const run = await runQuotaReadJob(w.deps);
    expect(run.outcome).toBe('unscanned');
    expect(w.finished[0]).toMatchObject({ outcome: 'unscanned' });
  });
});

describe('估算池的用量记录（usageRecordsFrom）', () => {
  const row = (over: Partial<Parameters<typeof usageRecordsFrom>[1][number]> = {}) => ({
    startedAt: minutesAgo(10),
    modelId: 'm1',
    inputTokens: 100,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: 0.5,
    ...over,
  });

  it('有花费的会话转成记录，为空的字段不带', () => {
    expect(usageRecordsFrom('p1', [row()])).toEqual([
      { poolId: 'p1', at: minutesAgo(10).toISOString(), modelId: 'm1', inputTokens: 100, costUsd: 0.5 },
    ]);
  });

  it('【故意造出的失败】没记到花费的会话不进记录，不拿 0 冒充', () => {
    expect(usageRecordsFrom('p1', [row({ costUsd: null }), row({ costUsd: 0 })])).toHaveLength(1);
  });
});
