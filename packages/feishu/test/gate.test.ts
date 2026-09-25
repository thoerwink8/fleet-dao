// 发送出口的两道闸：免打扰（北京时间，可跨夜）、每天求人卡的预算（按北京时间换日）。
import { describe, expect, it } from 'vitest';
import { DailyBudget, quietUntil } from '../src/gate.ts';

/** 北京时间 2026-09-25 的某一刻。 */
const bj = (hhmm: string, day = 25) => Date.parse(`2026-09-${String(day).padStart(2, '0')}T${hhmm}:00+08:00`);

describe('免打扰', () => {
  it('跨夜的 23:00–08:00：夜里在，白天不在；结束时刻是第二天 08:00', () => {
    const q = { start: '23:00', end: '08:00' };
    expect(quietUntil(q, bj('23:30'))).toBe(bj('08:00', 26));
    expect(quietUntil(q, bj('02:00'))).toBe(bj('08:00'));
    expect(quietUntil(q, bj('08:00'))).toBeNull();
    expect(quietUntil(q, bj('22:59'))).toBeNull();
  });

  it('同一天的 12:00–13:30：中间在，两头不在', () => {
    const q = { start: '12:00', end: '13:30' };
    expect(quietUntil(q, bj('12:00'))).toBe(bj('13:30'));
    expect(quietUntil(q, bj('13:30'))).toBeNull();
    expect(quietUntil(q, bj('11:59'))).toBeNull();
  });

  it('没设、起止相同：没有免打扰；格式认不出：报错，不当成没设（免得半夜照发）', () => {
    expect(quietUntil(null, bj('03:00'))).toBeNull();
    expect(quietUntil({ start: '08:00', end: '08:00' }, bj('08:00'))).toBeNull();
    expect(() => quietUntil({ start: '25:00', end: '08:00' }, bj('03:00'))).toThrow('免打扰时段格式认不出');
  });
});

describe('求人卡预算', () => {
  it('当天用完就不给；只提醒一次；发送失败的名额还回去；过了北京时间零点重新算', () => {
    const b = new DailyBudget(2);
    const noon = bj('12:00');
    expect([b.take(noon), b.take(noon), b.take(noon)]).toEqual([true, true, false]);
    expect([b.firstOverrun(noon), b.firstOverrun(noon)]).toEqual([true, false]);
    b.giveBack(noon);
    expect(b.take(noon)).toBe(true);
    // 北京时间 23:59 还是同一天，00:00 换日。
    expect(b.take(bj('23:59'))).toBe(false);
    expect(b.take(bj('00:00', 26))).toBe(true);
    expect(b.usedToday(bj('00:01', 26))).toBe(1);
  });
});
