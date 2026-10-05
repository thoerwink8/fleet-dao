// 额度页顶上说独享的额度留量线现状（#194 方案 4.8）：线只来自库里的设置，没有默认；到线、读不到、认不出各说一句。
import type { PoolViewSchema } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { soloReserveView } from '../src/reserve-view.ts';

type PoolView = z.input<typeof PoolViewSchema>;
const NOW = new Date('2026-10-05T00:00:00.000Z');
const iso = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

const win = (over: Record<string, unknown> = {}) => ({
  label: 'seven_day',
  window: '7d' as const,
  utilization: 0.5,
  unit: 'percent' as const,
  resetsAt: iso(72),
  reading: 'measured' as const,
  source: 'test',
  readAt: iso(-0.1),
  stale: false,
  ...over,
});
const pool = (windows: PoolView['windows'], over: Partial<PoolView> = {}): PoolView =>
  ({
    id: 'claude-solo',
    channelId: 'claude-subscription',
    channelName: '独享号',
    billing: 'subscription',
    channelEnabled: true,
    orgKind: 'solo',
    maxConcurrency: 3,
    running: 0,
    quotaStatus: 'fresh',
    windows,
    ...over,
  }) as PoolView;
const lines = { 'claude-solo': { '5h': 0.8, '7d': 0.7 } };

describe('soloReserveView', () => {
  it('周窗 75%、线 70%：reached，写明哪条线', () => {
    const v = soloReserveView([pool([win({ utilization: 0.75 })])], lines, NOW);
    expect(v).toEqual({ state: 'reached', why: '周额度用了 75%，到了留量线 70%' });
  });

  it('没到线、读数都在：没有这一项（没什么要说的）', () => {
    const five = win({ label: '5h', window: '5h', utilization: 0.1 });
    expect(soloReserveView([pool([five, win({ utilization: 0.2 })])], lines, NOW)).toBeUndefined();
  });

  it('这个池没写线 = 不限：用 99% 也不说到线；拼车、别家的池不看', () => {
    expect(soloReserveView([pool([win({ utilization: 0.99 })])], {}, NOW)).toBeUndefined();
    expect(
      soloReserveView(
        [pool([win({ utilization: 0.99 })], { orgKind: 'carpool', id: 'claude-carpool' })],
        lines,
        NOW,
      ),
    ).toBeUndefined();
  });

  it('【故意造出失败】库里没有这一行（undefined）：unreadable，写明种子没装上，不当成不限', () => {
    const v = soloReserveView([pool([win()])], undefined, NOW);
    expect(v).toMatchObject({ state: 'unreadable' });
    expect(v?.why).toContain('没装进库');
    // 没有独享池（开发环境的内存版）不说
    expect(soloReserveView([], undefined, NOW)).toBeUndefined();
  });

  it('【故意造出失败】线是负数 / 大于 1 / 整份不是对象：unreadable，写明原因', () => {
    for (const bad of [{ 'claude-solo': { '7d': -1 } }, { 'claude-solo': { '7d': 2 } }, 'on']) {
      expect(soloReserveView([pool([win()])], bad, NOW), JSON.stringify(bad)).toMatchObject({
        state: 'unreadable',
      });
    }
  });

  it('【故意造出失败】配了线却没有这个窗口的读数：unknown（额度未知），不当成没到线；已过清零时刻也是未知', () => {
    const noWeek = soloReserveView(
      [pool([win({ label: '5h', window: '5h', utilization: 0.1 })])],
      lines,
      NOW,
    );
    expect(noWeek).toMatchObject({ state: 'unknown' });
    expect(noWeek?.why).toContain('读数里没有这个窗口');
    const passed = soloReserveView(
      [
        pool([
          win({ label: '5h', window: '5h', utilization: 0.1 }),
          win({ utilization: 0.9, resetsAt: iso(-1) }),
        ]),
      ],
      lines,
      NOW,
    );
    expect(passed).toMatchObject({ state: 'unknown' });
  });

  it('旧读数已超线算数；上游说 limit_reached 算到线', () => {
    expect(soloReserveView([pool([win({ utilization: 0.8, stale: true })])], lines, NOW)).toMatchObject({
      state: 'reached',
    });
    expect(
      soloReserveView([pool([win({ utilization: undefined, upstreamStatus: 'limit_reached' })])], lines, NOW),
    ).toMatchObject({ state: 'reached' });
  });
});
