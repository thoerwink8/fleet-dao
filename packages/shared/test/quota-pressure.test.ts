// 池压力 ρ 和「照现速清零时剩多少 / 提前几小时用完」（#2737）。
import { describe, expect, it } from 'vitest';
import { poolPressureWindow, quotaPressure } from '../src/quota.ts';

const NOW = Date.parse('2026-10-16T08:00:00.000Z');
const HOUR = 3_600_000;
const at = (h: number) => new Date(NOW + h * HOUR).toISOString();

describe('quotaPressure', () => {
  it('Mirasim 30 天积分：时间过了约 17%、已用 67.6%，ρ≈0.39，照现速约 58 小时后用完（提前约 540 小时）', () => {
    const p = quotaPressure(
      { window: 'other', label: '30d', used: 0.676, resetsAt: at(598), readAt: at(0) },
      NOW,
    );
    expect(p).not.toBeNull();
    expect(p?.pace.elapsed).toBeCloseTo(1 - 598 / 720, 6);
    expect(p?.rho).toBeCloseTo(0.324 / (598 / 720), 6);
    expect(p?.rateFrom).toBe('average');
    expect(p?.leftAtReset).toBe(0);
    expect(p?.exhaustedHoursEarly).toBeCloseTo(598 - 0.324 / (0.676 / (720 - 598)), 6);
  });

  it('Cursor 的桶：12 小时后清零、最近 24 小时一点没动，按历史速度 0，清零时剩 80% 作废；ρ 很大', () => {
    const resetsAt = at(12);
    const p = quotaPressure(
      { window: 'other', label: 'auto_percent', used: 0.2, resetsAt, readAt: at(0) },
      NOW,
      [
        { readAt: at(-20), used: 0.2, resetsAt },
        { readAt: at(-6), used: 0.2, resetsAt },
      ],
    );
    expect(p?.rateFrom).toBe('samples');
    expect(p?.ratePerHour).toBe(0);
    expect(p?.leftAtReset).toBeCloseTo(0.8, 9);
    expect(p?.exhaustedHoursEarly).toBeNull();
    expect(p?.rho).toBeCloseTo(0.8 / (12 / 720), 6);
  });

  it('历史速度：同一期最近 24 小时首尾两点之差；上一期（清零时刻不同）、24 小时以前、未来的点不算', () => {
    const resetsAt = at(48);
    const p = quotaPressure({ window: '7d', label: '7d', used: 0.5, resetsAt, readAt: at(0) }, NOW, [
      { readAt: at(-30), used: 0.0, resetsAt },
      { readAt: at(-10), used: 0.4, resetsAt },
      { readAt: at(-5), used: 0.9, resetsAt: at(-1) },
      { readAt: at(1), used: 0.99, resetsAt },
    ]);
    expect(p?.rateFrom).toBe('samples');
    expect(p?.ratePerHour).toBeCloseTo(0.01, 9);
    expect(p?.leftAtReset).toBeCloseTo(0.5 - 0.48, 9);
  });

  it('历史不够半小时跨度：按本期平均速度', () => {
    const resetsAt = at(84);
    const p = quotaPressure({ window: '7d', used: 0.1, resetsAt, readAt: at(0) }, NOW, [
      { readAt: at(-0.2), used: 0.05, resetsAt },
    ]);
    expect(p?.rateFrom).toBe('average');
    expect(p?.ratePerHour).toBeCloseTo(0.1 / 84, 9);
  });

  it('算不出：没读到已用、没清零时刻、已过清零，返回 null（不拿 0 顶）', () => {
    expect(quotaPressure({ window: '7d', used: null, resetsAt: at(10), readAt: at(0) }, NOW)).toBeNull();
    expect(quotaPressure({ window: '7d', used: 0.3, resetsAt: null, readAt: at(0) }, NOW)).toBeNull();
    expect(quotaPressure({ window: '7d', used: 0.3, resetsAt: at(-1), readAt: at(0) }, NOW)).toBeNull();
  });
});

describe('poolPressureWindow', () => {
  it('5 小时窗不算；取清零时预计剩得最多的窗口；一个都算不出为空', () => {
    const windows = [
      { label: '5h', window: '5h' as const, used: 0, resetsAt: at(1), readAt: at(0) },
      { label: '7d', window: '7d' as const, used: 0.9, resetsAt: at(24), readAt: at(0) },
      { label: '30d', window: 'other' as const, used: 0.1, resetsAt: at(600), readAt: at(0) },
    ];
    // 7d 用了九成、照速清零时用光；30d 只用一成，照本期平均速度清零时还剩约四成：取 30d
    expect(poolPressureWindow(windows, NOW)?.window.label).toBe('30d');
    expect(poolPressureWindow(windows, NOW)?.pressure.leftAtReset).toBeCloseTo(0.9 - (0.1 / 120) * 600, 6);
    expect(poolPressureWindow([windows[0] as (typeof windows)[number]], NOW)).toBeNull();
  });
});
