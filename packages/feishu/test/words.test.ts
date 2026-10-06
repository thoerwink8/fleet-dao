// 北京时间的时刻：午夜必须是 00:xx。hour12:false 在部分运行时按 h24，会打成 24:xx。
import { describe, expect, it } from 'vitest';
import { beijingClock, when } from '../src/words.ts';

/** 北京时间 2026-10-05 00:30。 */
const MIDNIGHT = Date.parse('2026-10-04T16:30:00.000Z');

describe('北京时间', () => {
  it('午夜 00:30 显示成 00:30，不出现 24:【故意造出的失败】', () => {
    const clock = beijingClock(MIDNIGHT);
    expect(clock).toBe('00:30');
    expect(clock).not.toContain('24:');

    const sameDay = Date.parse('2026-10-04T18:00:00.000Z'); // 北京时间 2026-10-05 02:00
    const today = when(MIDNIGHT, sameDay);
    expect(today).toBe('00:30');
    expect(today).not.toContain('24:');

    const dayBefore = Date.parse('2026-10-04T10:00:00.000Z'); // 北京时间 2026-10-04 18:00
    const otherDay = when(MIDNIGHT, dayBefore);
    expect(otherDay).toBe('10-05 00:30');
    expect(otherDay).not.toContain('24:');
  });

  it('午夜这一小时都是 00:xx', () => {
    expect(beijingClock(Date.parse('2026-10-04T16:00:00.000Z'))).toBe('00:00');
    expect(beijingClock(Date.parse('2026-10-04T16:59:00.000Z'))).toBe('00:59');
  });

  it('别的钟点仍是 24 小时制的时:分', () => {
    expect(beijingClock(Date.parse('2026-10-05T06:02:00.000Z'))).toBe('14:02');
    expect(beijingClock(Date.parse('2026-10-05T15:59:00.000Z'))).toBe('23:59');
  });
});
