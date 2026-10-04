// 拼车烧速预估（carpool-burn.ts，#194 方案 4.1）：算不出就明说原因，不回 0、不回猜的数；每一种「算不出」各造一次。
import { describe, expect, it } from 'vitest';
import { type BurnRead, estimateBurn } from '../src/carpool-burn.ts';

const T0 = new Date('2026-10-04T12:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => new Date(T0.getTime() + m * MIN);
const read = (m: number, used: number, limit = 80, over: Partial<BurnRead> = {}): BurnRead => ({
  requestedAt: at(m),
  serverDate: at(m),
  ageSeconds: null,
  usedUsd: used,
  limitUsd: limit,
  ...over,
});

describe('烧速预估：读得出', () => {
  it('10 分钟花 $20、还剩 $40：每分钟 $2、约 20 分钟用满', () => {
    const e = estimateBurn([read(-10, 20), read(-5, 30), read(0, 40)], T0);
    expect(e).toMatchObject({
      state: 'known',
      usdPerMinute: 2,
      remainingUsd: 40,
      minutesLeft: 20,
      samples: 3,
    });
  });

  it('上限不写死：上限是 200 也按比例和读数算（剩余用最新读数的上限）', () => {
    const e = estimateBurn([read(-10, 100, 200), read(0, 150, 200)], T0);
    expect(e).toMatchObject({ state: 'known', usdPerMinute: 5, remainingUsd: 50, minutesLeft: 10 });
  });

  it('读数没排好序也行；超过 15 分钟的旧读数不进算', () => {
    const e = estimateBurn([read(0, 40), read(-30, 0), read(-10, 20)], T0);
    expect(e).toMatchObject({ state: 'known', usdPerMinute: 2, samples: 2 });
  });

  it('最近一分钱没花：读得出的事实（minutesLeft 为 null），不是「算不出」', () => {
    const e = estimateBurn([read(-10, 30), read(0, 30)], T0);
    expect(e).toMatchObject({ state: 'known', usdPerMinute: 0, minutesLeft: null, remainingUsd: 50 });
  });

  it('已经用满：0 分钟', () => {
    const e = estimateBurn([read(-10, 70), read(0, 80)], T0);
    expect(e).toMatchObject({ state: 'known', remainingUsd: 0, minutesLeft: 0 });
  });

  it('回包头 Age 超过上限的缓存读数、服务端 Date 没往前走的重复读数不算样本', () => {
    const e = estimateBurn(
      [
        read(-10, 20),
        read(-6, 99, 80, { ageSeconds: 600 }), // 缓存：金额是旧的，不能拿来算
        read(-4, 25, 80, { serverDate: at(-10) }), // 回的还是第一份
        read(0, 40),
      ],
      T0,
    );
    expect(e).toMatchObject({ state: 'known', usdPerMinute: 2, samples: 2 });
  });
});

describe('烧速预估：【故意造出失败】算不出就明说，不显示 0 也不显示猜的数', () => {
  const unknownWhy = (reads: BurnRead[], now = T0) => {
    const e = estimateBurn(reads, now);
    expect(e.state).toBe('unknown');
    return e.state === 'unknown' ? e.why : '';
  };

  it('一个读数都没有 / 只有 1 个：算不出', () => {
    expect(unknownWhy([])).toContain('没有读到过');
    expect(unknownWhy([read(0, 10)])).toContain('只有 1 个');
  });

  it('只剩 1 个算数的（别的是缓存）：算不出', () => {
    expect(unknownWhy([read(-5, 10), read(0, 20, 80, { ageSeconds: 300 })])).toContain('只有 1 个');
  });

  it('两头隔得太近（不到 2 分钟）：算不出，不把零头折成每分钟几美元', () => {
    expect(unknownWhy([read(-1, 10), read(0, 11)])).toContain('隔得太近');
  });

  it('花费为负（额度窗口刚清零）：算不出', () => {
    expect(unknownWhy([read(-10, 70), read(-5, 5), read(0, 8)])).toContain('变少了');
  });

  it('最近一次读数太旧（读接口停了）：算不出，不拿旧速度冒充现在', () => {
    expect(unknownWhy([read(-14, 10), read(-12, 20)])).toContain('分钟前');
  });

  it('读数时刻在未来（钟对不上）：算不出', () => {
    expect(unknownWhy([read(5, 10), read(9, 20)])).toContain('钟对不上');
  });

  it('金额认不出（NaN、负数、上限 0）：算不出', () => {
    expect(unknownWhy([read(-5, 10), read(0, Number.NaN)])).toContain('金额认不出');
    expect(unknownWhy([read(-5, -1), read(0, 5)])).toContain('金额认不出');
    expect(unknownWhy([read(-5, 1, 0), read(0, 5, 0)])).toContain('金额认不出');
  });
});
