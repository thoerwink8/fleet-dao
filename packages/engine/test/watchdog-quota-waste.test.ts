// 看门狗「额度快作废」（#2737，jobs/watchdog-quota-waste.ts）：48 小时内清零、预计作废不少于 30% 推一条，列出接得住的路由
// （关着的也列）；不再中的撤；正文没变不改卡；读不到这一轮记没查成、不撤。
import type { QuotaSampleRow, QuotaTablePool } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  type PoolRouteFact,
  QUOTA_WASTE_PREFIX,
  type QuotaWasteDeps,
  quotaWasteKey,
  watchQuotaWaste,
} from '../src/jobs/watchdog-quota-waste.ts';

const NOW = new Date('2026-10-16T08:00:00.000Z');
const H = 3_600_000;
const at = (h: number) => new Date(NOW.getTime() + h * H);

type W = QuotaTablePool['windows'][number];
const win = (over: Partial<W>): W =>
  ({
    label: 'auto_percent',
    window: 'other',
    scope: null,
    utilization: 0.2,
    used: null,
    limit: null,
    unit: 'percent',
    remainingRatio: 0.8,
    resetsAt: at(19),
    resetsInMs: 19 * H,
    upstreamStatus: null,
    statusRaw: null,
    reading: 'measured',
    source: 'cursor-dashboard',
    readAt: at(-0.1),
    staleSince: null,
    state: 'ok',
    ...over,
  }) as W;

const pool = (poolId: string, windows: W[], over: Partial<QuotaTablePool> = {}): QuotaTablePool =>
  ({
    poolId,
    channelId: 'ch',
    channelName: 'Cursor',
    billing: 'subscription',
    channelEnabled: true,
    maxConcurrency: 3,
    inFlight: 0,
    expiresAt: null,
    scopeModels: null,
    routeCount: 2,
    lastReadOkAt: at(-0.1),
    dataAt: at(-0.1),
    neverRead: false,
    readOverdue: false,
    windows,
    ...over,
  }) as QuotaTablePool;

/** 最近一天 Cursor 那个桶一点没动。 */
const flat = (poolId: string, label = 'auto_percent', resetsAt = at(19)): QuotaSampleRow[] => [
  {
    poolId,
    label,
    window: 'other',
    scope: null,
    unit: 'percent',
    utilization: 0.2,
    resetsAt,
    reading: 'measured',
    readAt: at(-20),
  },
];

const ROUTES: PoolRouteFact[] = [
  { routeId: 'cursor:auto', poolId: 'cursor', modelId: 'cursor-auto', enabled: true, alive: true },
  { routeId: 'cursor:luna', poolId: 'cursor', modelId: 'gpt-5.6-luna', enabled: false, alive: true },
  { routeId: 'grok:grok-4.7', poolId: 'grok', modelId: 'grok-4.7', enabled: true, alive: true },
];

interface Card {
  dedupeKey: string;
  title: string;
  body: string;
  link?: string;
}

function world(over: Partial<QuotaWasteDeps> & { open?: Card[] } = {}) {
  const open = new Map((over.open ?? []).map((c) => [c.dedupeKey, c] as const));
  const raised: Card[] = [];
  const resolved: string[] = [];
  const deps: QuotaWasteDeps = {
    quotaPools: over.quotaPools ?? (async () => []),
    quotaSamples: over.quotaSamples ?? (async () => []),
    poolRoutes: over.poolRoutes ?? (async () => ROUTES),
    alerts: {
      async openByPrefix(prefix) {
        return [...open.values()].filter((c) => c.dedupeKey.startsWith(prefix));
      },
      async raise(c) {
        raised.push(c);
        open.set(c.dedupeKey, c);
      },
      async resolve(x) {
        resolved.push(x.dedupeKey);
        return open.delete(x.dedupeKey) ? 'ok' : 'not_found';
      },
    },
    log: () => {},
  };
  return { deps, raised, resolved, open };
}

describe('额度快作废', () => {
  it('Cursor 桶 19 小时后清零、一天没动：推一条，列出接得住的路由，关着的也列', async () => {
    const w = world({
      quotaPools: async () => [pool('cursor', [win({})])],
      quotaSamples: async () => flat('cursor'),
    });
    const r = await watchQuotaWaste(w.deps, NOW);
    expect(r).toEqual({ scanned: 1, found: 1, problems: [] });
    expect(w.raised).toHaveLength(1);
    const card = w.raised[0] as Card;
    expect(card.dedupeKey).toBe(quotaWasteKey('cursor'));
    expect(card.title).toContain('预计剩 80% 以上');
    expect(card.body).toContain('cursor:auto（cursor-auto，开着）');
    expect(card.body).toContain('cursor:luna（gpt-5.6-luna，关着：去路由页打开就能接）');
    expect(card.body).not.toContain('grok:grok-4.7');
    expect(card.link).toBe('/quota');
  });

  it('清零在 48 小时以后、预计作废不到 30%、5 小时窗、读数过期的窗口：不报', async () => {
    const w = world({
      quotaPools: async () => [
        pool('far', [win({ resetsAt: at(60), resetsInMs: 60 * H })]),
        // 本期平均速度 0.95 ÷ 已过的小时，19 小时后剩不到三成
        pool('busy', [win({ utilization: 0.95 })]),
        pool('five', [win({ window: '5h', label: '5h', resetsAt: at(2) })]),
        pool('stale', [win({ state: 'stale' })]),
      ],
    });
    const r = await watchQuotaWaste(w.deps, NOW);
    expect(r.found).toBe(0);
    expect(w.raised).toHaveLength(0);
  });

  it('正文没变不改卡；不再中的撤掉', async () => {
    const first = world({
      quotaPools: async () => [pool('cursor', [win({})])],
      quotaSamples: async () => flat('cursor'),
    });
    await watchQuotaWaste(first.deps, NOW);
    const card = first.raised[0] as Card;
    const again = world({
      open: [card, { dedupeKey: `${QUOTA_WASTE_PREFIX}old`, title: 't', body: 'b' }],
      quotaPools: async () => [pool('cursor', [win({})])],
      quotaSamples: async () => flat('cursor'),
    });
    await watchQuotaWaste(again.deps, NOW);
    expect(again.raised).toHaveLength(0);
    expect(again.resolved).toEqual([`${QUOTA_WASTE_PREFIX}old`]);
  });

  it('【故意造出的失败】额度历史读不了：这一轮记没查成，开着的一条都不撤', async () => {
    const w = world({
      open: [{ dedupeKey: quotaWasteKey('cursor'), title: 't', body: 'b' }],
      quotaPools: async () => [pool('cursor', [win({})])],
      quotaSamples: async () => {
        throw new Error('quota_window_samples 读不了');
      },
    });
    const r = await watchQuotaWaste(w.deps, NOW);
    expect(r.problems.join('')).toContain('额度快作废这一轮没查');
    expect(w.resolved).toEqual([]);
  });
});
