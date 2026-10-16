// 消耗进度（#2363）：按时间该用多少、实际用了多少；选路和额度页共用。
import { describe, expect, it } from 'vitest';
import { PACE_FALLBACK_SPAN_MS, quotaPace, quotaWindowSpan } from '../src/quota.ts';

const NOW = Date.parse('2026-10-16T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('窗口长度按种类或标签取', () => {
  it('周窗 7 天、5 小时窗 5 小时、按月 30 天，都不是估的', () => {
    expect(quotaWindowSpan({ window: '7d', label: 'credits:weekly' })).toEqual({
      ms: 7 * DAY,
      estimated: false,
    });
    expect(quotaWindowSpan({ window: '7d_model', label: '7d_claude' })).toEqual({
      ms: 7 * DAY,
      estimated: false,
    });
    expect(quotaWindowSpan({ window: '5h', label: '5h' })).toEqual({ ms: 5 * HOUR, estimated: false });
    expect(quotaWindowSpan({ window: 'month_usd', label: 'plan_usd' })).toEqual({
      ms: 30 * DAY,
      estimated: false,
    });
  });

  it('other 按标签开头的时长取：30d 是 30 天', () => {
    expect(quotaWindowSpan({ window: 'other', label: '30d' })).toEqual({ ms: 30 * DAY, estimated: false });
    expect(quotaWindowSpan({ window: 'other', label: '2w_x' })).toEqual({ ms: 14 * DAY, estimated: false });
  });

  it('推不出（Cursor 的 auto_percent 桶）按 30 天并标估算', () => {
    expect(quotaWindowSpan({ window: 'other', label: 'auto_percent' })).toEqual({
      ms: PACE_FALLBACK_SPAN_MS,
      estimated: true,
    });
  });
});

describe('消耗进度', () => {
  it('周窗：已用 75%、窗口过了 62%，超前 13%', () => {
    const p = quotaPace(
      { window: '7d', label: 'credits:weekly', used: 0.75, resetsAt: at(0.38 * 7 * DAY) },
      NOW,
    );
    expect(p?.elapsed).toBeCloseTo(0.62, 5);
    expect(p?.behind).toBeCloseTo(-0.13, 5);
    expect(p?.estimated).toBe(false);
  });

  it('30 天窗：已用 66%、窗口才过 19%，超前 47%', () => {
    const p = quotaPace({ window: 'other', label: '30d', used: 0.66, resetsAt: at(0.81 * 30 * DAY) }, NOW);
    expect(p?.elapsed).toBeCloseTo(0.19, 5);
    expect(p?.behind).toBeCloseTo(-0.47, 5);
    expect(p?.estimated).toBe(false);
  });

  it('Cursor 桶：已用 13%、账期过了 98%（按 30 天估），落后 85%', () => {
    const p = quotaPace(
      { window: 'other', label: 'auto_percent', used: 0.13, resetsAt: at(0.02 * 30 * DAY) },
      NOW,
    );
    expect(p?.elapsed).toBeCloseTo(0.98, 5);
    expect(p?.behind).toBeCloseTo(0.85, 5);
    expect(p?.estimated).toBe(true);
  });

  it('离清零比估的窗口还远：已过记 0，不出负数', () => {
    const p = quotaPace({ window: 'other', label: 'auto_percent', used: 0.1, resetsAt: at(40 * DAY) }, NOW);
    expect(p?.elapsed).toBe(0);
  });

  it('已用、清零时刻缺或认不出、清零已过：算不出，返回 null', () => {
    expect(quotaPace({ window: '7d', used: null, resetsAt: at(DAY) }, NOW)).toBeNull();
    expect(quotaPace({ window: '7d', used: 0.5, resetsAt: null }, NOW)).toBeNull();
    expect(quotaPace({ window: '7d', used: 0.5, resetsAt: 'not-a-date' }, NOW)).toBeNull();
    expect(quotaPace({ window: '7d', used: 0.5, resetsAt: at(-HOUR) }, NOW)).toBeNull();
  });
});
