// 额度页每个池一行的池压力（#2737）：该用多少、实际用了多少、ρ、清零时预计剩多少；读不到写为什么，不拿 0 顶。
import { PoolsResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { QuotaSampleRecord, QuotaWindowRecord } from '../src/ports.ts';
import { buildPools } from '../src/views.ts';

const NOW = new Date('2026-10-16T08:00:00.000Z');
const HOUR = 3_600_000;
const at = (h: number) => new Date(NOW.getTime() + h * HOUR).toISOString();

const win = (poolId: string, over: Partial<QuotaWindowRecord>): QuotaWindowRecord => ({
  poolId,
  label: '7d',
  window: '7d',
  unit: 'percent',
  reading: 'measured',
  source: 'test',
  readAt: at(-0.1),
  ...over,
});

const build = (windows: QuotaWindowRecord[], samples: QuotaSampleRecord[] = []) =>
  buildPools(
    {
      pools: ['cursor', 'mirasim', 'grok', 'empty'].map((id) => ({ id, channelId: 'ch', maxConcurrency: 1 })),
      channels: [{ id: 'ch', name: '渠道', billing: 'subscription', enabled: true }],
      windows,
      occupancy: { pools: [], inFlightByStage: {} },
      samples,
    },
    NOW,
    30 * 60_000,
  );

describe('池压力', () => {
  const resetsAt = at(19);
  const views = build(
    [
      win('cursor', { label: 'auto_percent', window: 'other', utilization: 0.2, resetsAt }),
      win('mirasim', { label: '30d', window: 'other', utilization: 0.676, resetsAt: at(598) }),
      win('grok', { utilization: 0.3, resetsAt: at(48), readAt: at(-2) }),
    ],
    [
      {
        poolId: 'cursor',
        label: 'auto_percent',
        window: 'other',
        unit: 'percent',
        reading: 'measured',
        utilization: 0.2,
        resetsAt,
        readAt: at(-20),
      },
    ],
  );
  const byId = new Map(views.map((v) => [v.id, v]));

  it('Cursor：一天没动，按历史速度清零时剩 80%；ρ 远大于 1', () => {
    const p = byId.get('cursor')?.pressure;
    expect(p).toMatchObject({ state: 'known', label: 'auto_percent', used: 0.2, rateFrom: 'samples' });
    expect(p?.state === 'known' && p.leftAtReset).toBeCloseTo(0.8, 9);
    expect(p?.state === 'known' && (p.rho ?? 0) > 1).toBe(true);
  });

  it('Mirasim：该用约 17%、实际 67.6%，ρ<1，照现速提前用完', () => {
    const p = byId.get('mirasim')?.pressure;
    expect(p?.state).toBe('known');
    if (p?.state !== 'known') return;
    expect(p.expectedUsed).toBeCloseTo(1 - 598 / 720, 6);
    expect(p.rho).toBeLessThan(1);
    expect(p.leftAtReset).toBe(0);
    expect(p.exhaustedHoursEarly).toBeGreaterThan(500);
  });

  it('读数过期、一个窗口都没有：写为什么，不给 0', () => {
    expect(byId.get('grok')?.pressure).toEqual({ state: 'unknown', why: '读数过期，不当现值' });
    expect(byId.get('empty')?.pressure).toEqual({ state: 'unknown', why: '只有 5 小时窗，或一个窗口都没有' });
  });

  it('过得了接口 schema', () => {
    expect(() =>
      PoolsResponse.parse({ pools: views, staleAfterMinutes: 30, asOf: NOW.toISOString() }),
    ).not.toThrow();
  });
});
