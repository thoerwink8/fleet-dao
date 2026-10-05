// 账号池满没满（#800）：在跑的 + 已选定还没开工的，驾驶舱路由页、换路由选项、候选查询、引擎选路都用这一个判法。
import { describe, expect, it } from 'vitest';
import { poolFull, poolOccupied, poolOccupiedText } from '../src/pool-slots.ts';

describe('poolFull / poolOccupied', () => {
  it('池上限 3、1 个在跑、2 个已选定：占 3 个，满了（只数在跑的会说 1/3 没满）', () => {
    const pool = { inFlight: 1, reserved: 2, maxConcurrency: 3 };
    expect(poolOccupied(pool)).toBe(3);
    expect(poolFull(pool)).toBe(true);
    // 预占过期、被清掉之后（reserved 回到 0）不再算
    expect(poolFull({ ...pool, reserved: 0 })).toBe(false);
  });

  it('没有已选定的：和只数在跑一样；差一个不算满，超了也算满', () => {
    expect(poolFull({ inFlight: 2, reserved: 0, maxConcurrency: 3 })).toBe(false);
    expect(poolFull({ inFlight: 3, reserved: 0, maxConcurrency: 3 })).toBe(true);
    expect(poolFull({ inFlight: 2, reserved: 2, maxConcurrency: 3 })).toBe(true);
    expect(poolFull({ inFlight: 0, reserved: 2, maxConcurrency: 3 })).toBe(false);
  });

  it('白话：有已选定的写明两样各几个，没有的只说在跑几个', () => {
    expect(poolOccupiedText({ inFlight: 1, reserved: 2 })).toBe(
      '已经有 3 个（在跑 1 个、已选定还没开工 2 个）',
    );
    expect(poolOccupiedText({ inFlight: 2, reserved: 0 })).toBe('已经在跑 2 个');
  });

  it('【故意造出的失败】数不是非负整数（负数、小数、NaN）：明确抛，不当成 0、不当成没满', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => poolFull({ inFlight: bad, reserved: 0, maxConcurrency: 3 })).toThrow(/在跑数/);
      expect(() => poolFull({ inFlight: 0, reserved: bad, maxConcurrency: 3 })).toThrow(/已选定数/);
      expect(() => poolFull({ inFlight: 0, reserved: 0, maxConcurrency: bad })).toThrow(/并发上限/);
    }
  });
});
