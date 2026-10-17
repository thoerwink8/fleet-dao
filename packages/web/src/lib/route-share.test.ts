import { describe, expect, it } from 'vitest';
import { shareBanners, shareEvenness, shareLine } from './route-share';

const a = { label: 'Grok 订阅', weight: 1, recent: 10 };
const b = { label: 'Cursor', weight: 1, recent: 10 };

describe('同一档这句话', () => {
  it('样本够、对得上权重是均匀', () => {
    expect(shareEvenness([a, b])).toBe('均匀');
    expect(shareLine([a, b])).toBe('同一档：Grok 订阅 50%（权重 1）、Cursor 50%（权重 1）；均匀');
  });

  it('差过 15 个点是不均匀', () => {
    expect(
      shareEvenness([
        { ...a, recent: 10 },
        { ...b, recent: 0 },
      ]),
    ).toBe('不均匀');
  });

  it('不到 8 次还看不出', () => {
    expect(
      shareEvenness([
        { ...a, recent: 3 },
        { ...b, recent: 1 },
      ]),
    ).toBe('近 14 天 4 次，还看不出均不均');
  });

  it('权重 2:1 写成 67% 和 33%；单独一条不说', () => {
    expect(shareLine([{ ...a, weight: 2 }, b])).toContain('67%');
    expect(shareLine([{ ...a, weight: 2 }, b])).toContain('33%');
    expect(shareBanners([{ ...a, band: 0 }])).toEqual([]);
  });
});
