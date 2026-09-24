import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dailyTokenFilesSource,
  type EstimateWindowSpec,
  estimateWindows,
  type PoolQuotaResult,
  readAllQuotas,
  type UsageRecord,
  windowSpan,
} from '../../src/quota/index.ts';
import { blockNetwork, FIXED_NOW, FIXTURES, fakeDeps, fixture } from './helpers.ts';

blockNetwork();

const day: EstimateWindowSpec = {
  label: 'day_usd',
  window: 'period_usd',
  unit: 'usd',
  periodHours: 24,
  anchor: '2026-01-01T00:00:00.000Z',
  limit: 0.3,
};

describe('估算窗口的时间段', () => {
  it('固定窗：从 anchor 起每 periodHours 一格，清零时刻可算', () => {
    const span = windowSpan(day, FIXED_NOW);
    expect(new Date(span.start).toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(span.end && new Date(span.end).toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it('滚动窗：往回看 periodHours，没有单一的清零时刻', () => {
    const rolling: EstimateWindowSpec = { label: '5h_usd', window: 'other', unit: 'usd', periodHours: 5 };
    const span = windowSpan(rolling, FIXED_NOW);
    expect(new Date(span.start).toISOString()).toBe('2026-09-24T14:00:00.000Z');
    expect(span.end).toBeUndefined();
  });
});

describe('按用量记录估已用量', () => {
  const rec = (at: string, costUsd?: number, modelId?: string): UsageRecord => ({
    poolId: 'p',
    at,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(modelId === undefined ? {} : { modelId }),
  });

  it('只算窗口内的记录，标 estimated，上限来自配置', () => {
    const { windows } = estimateWindows(
      [day],
      [rec('2026-09-23T23:59:00Z', 5), rec('2026-09-24T01:00:00Z', 0.1), rec('2026-09-24T18:00:00Z', 0.05)],
      { poolId: 'jev', now: FIXED_NOW },
    );
    expect(windows).toEqual([
      {
        poolId: 'jev',
        window: 'period_usd',
        label: 'day_usd',
        unit: 'usd',
        used: expect.closeTo(0.15, 10),
        limit: 0.3,
        utilization: expect.closeTo(0.5, 10),
        resetsAt: '2026-09-25T00:00:00.000Z',
        reading: 'estimated',
        readAt: FIXED_NOW.toISOString(),
        source: 'estimate',
      },
    ]);
  });

  it('缺金额的记录不硬算、写明是下限；模型组窗口只算本组、没写模型的算不进', () => {
    const scoped: EstimateWindowSpec = { ...day, label: 'opus_day', scope: 'opus' };
    const out = estimateWindows(
      [day, scoped],
      [
        rec('2026-09-24T01:00:00Z'),
        rec('2026-09-24T02:00:00Z', 1, 'claude-opus-5-5'),
        rec('2026-09-24T03:00:00Z', 2),
      ],
      { poolId: 'p', now: FIXED_NOW },
    );
    expect(out.windows.map((w) => [w.label, w.used])).toEqual([
      ['day_usd', 3],
      ['opus_day', 1],
    ]);
    expect(out.notes.join('\n')).toContain('下限');
    expect(out.notes.join('\n')).toContain('没写模型');
  });
});

describe('Jev 日账（旧系统 ~/.dao/judge-spend 的形状）', () => {
  const dir = join(FIXTURES, 'jev-spend');
  const io = {
    homeDir: '/home/tester',
    listDir: async () => ['2026-09-23.json', '2026-09-24.json', 'cache'],
    readFile: async (p: string) => fixture(join('jev-spend', p.replace(/\\/g, '/').split('/').pop() ?? '')),
  };

  it('每个 UTC 日一条记录，金额 = tokens × 每百万单价', async () => {
    const source = dailyTokenFilesSource({ type: 'daily-token-files', dir, usdPerMTok: 0.042 }, io, 'jev');
    const records = await source({
      poolId: 'jev',
      since: new Date('2026-09-24T00:00:00Z'),
      until: FIXED_NOW,
    });
    expect(records).toEqual([
      {
        poolId: 'jev',
        at: '2026-09-24T00:00:00.000Z',
        inputTokens: 428343,
        costUsd: expect.closeTo(0.017990406, 12),
      },
    ]);
  });

  it('读取器：没有用量来源时报 no_usage_source，不是零', async () => {
    const report = await readAllQuotas(
      { pools: [{ poolId: 'jev', channelId: 'jev', reader: 'estimate', windows: [day] }] },
      fakeDeps(),
    );
    const r = report.results[0] as PoolQuotaResult;
    expect(!r.ok && r.error.code).toBe('no_usage_source');
  });

  it('读取器：读日账估今天用了多少', async () => {
    const report = await readAllQuotas(
      {
        pools: [
          {
            poolId: 'jev',
            channelId: 'jev',
            reader: 'estimate',
            windows: [day],
            usage: { type: 'daily-token-files', dir, usdPerMTok: 0.042 },
          },
        ],
      },
      fakeDeps({ listDir: io.listDir, readFile: io.readFile }),
    );
    const r = report.results[0] as PoolQuotaResult;
    expect(r.ok && r.windows[0]).toMatchObject({
      reading: 'estimated',
      used: expect.closeTo(0.018, 3),
      limit: 0.3,
    });
    expect(r.notes.join()).toContain('不是上游账单');
  });

  it('读取器：引擎注入的用量记录也能用', async () => {
    const report = await readAllQuotas(
      { pools: [{ poolId: 'jev', channelId: 'jev', reader: 'estimate', windows: [day] }] },
      fakeDeps({ usageRecords: async () => [{ poolId: 'jev', at: '2026-09-24T10:00:00Z', costUsd: 0.2 }] }),
    );
    const r = report.results[0] as PoolQuotaResult;
    expect(r.ok && r.windows[0]?.utilization).toBeCloseTo(0.2 / 0.3, 10);
  });
});
