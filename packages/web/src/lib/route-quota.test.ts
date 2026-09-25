// 只扣一组模型的窗用满了（比如只有 fable 组满了）：同池别的路由不算满，满的那一组写明是哪一组。
// 调度台的路由行、换模型对话框都按路由算（routeQuotaHeadline，判法同 shared 的 windowAppliesTo）。
import { describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { PoolView, QuotaWindowView } from '../api/types';
import { routeOptions } from '../components/task-actions';
import { headlineText, quotaHeadline, routeQuotaHeadline } from './catalog';

const NOW = Date.parse('2026-09-25T08:00:00Z');

function win(p: Partial<QuotaWindowView>): QuotaWindowView {
  return {
    label: '7d',
    window: '7d',
    unit: 'percent',
    reading: 'measured',
    source: 'relay-web',
    readAt: '2026-09-25T07:50:00Z',
    stale: false,
    ...p,
  };
}

const POOL: Pick<PoolView, 'quotaStatus' | 'windows'> = {
  quotaStatus: 'fresh',
  windows: [
    win({ label: 'period_usd', window: 'period_usd', unit: 'usd', used: 40, limit: 100 }),
    win({
      label: '7d_fable',
      window: '7d_model',
      scope: 'fable',
      utilization: 1,
      upstreamStatus: 'limit_reached',
    }),
  ],
};
const KIMI = { id: 'kimi-k3', family: 'kimi' };
const FABLE = { id: 'fable-5.1', family: 'claude' };

describe('按路由看额度', () => {
  test('只有 fable 组满了：Kimi 看账号级的窗（40%），fable 写「fable 组已用满」', () => {
    expect(headlineText(routeQuotaHeadline(POOL, KIMI))).toBe('40%');
    const fable = routeQuotaHeadline(POOL, FABLE);
    expect(fable.kind).toBe('full');
    expect(headlineText(fable)).toBe('fable 组已用满');
  });

  test('按池看（渠道页）：写明是哪一组满了，不说整个池「已用满」', () => {
    expect(headlineText(quotaHeadline(POOL))).toBe('fable 组已用满');
  });

  test('账号级的窗满了：池里每条路由都满', () => {
    const pool = {
      ...POOL,
      windows: [win({ upstreamStatus: 'limit_reached', utilization: 1 }), ...POOL.windows],
    };
    expect(headlineText(routeQuotaHeadline(pool, KIMI))).toBe('已用满');
    expect(headlineText(routeQuotaHeadline(pool, FABLE))).toBe('已用满');
  });

  test('池里只有别的组的窗：说「没有扣它的窗」，不说「上游没报额度窗」', () => {
    const pool = { quotaStatus: 'fresh' as const, windows: [POOL.windows[1] as QuotaWindowView] };
    expect(headlineText(routeQuotaHeadline(pool, KIMI))).toBe('没有扣它的窗');
  });

  test('模型在目录里查不到：整池一起算（宁可说紧）；池没读成照旧说没查成', () => {
    expect(headlineText(routeQuotaHeadline(POOL, undefined))).toBe('fable 组已用满');
    expect(headlineText(routeQuotaHeadline({ quotaStatus: 'unread', windows: [] }, KIMI))).toBe('额度没查成');
  });

  test('换模型对话框（假数据里中转站的 fable 组满了）：Kimi 不写满，Fable 写 fable 组已用满', async () => {
    const api = createMockApi({ live: false, now: () => NOW });
    const routing = await api.routing();
    const pools = await api.pools();
    const { ordered, others } = routeOptions(routing, pools.pools, 'execute', undefined, NOW);
    const all = [...ordered, ...others];
    const kimi = all.find((o) => o.id === 'r-rl-kimi');
    const fable = all.find((o) => o.id === 'r-rl-fable');
    expect(kimi?.quota && headlineText(kimi.quota)).not.toMatch(/满/);
    expect(fable?.quota && headlineText(fable.quota)).toBe('fable 组已用满');
  });
});
