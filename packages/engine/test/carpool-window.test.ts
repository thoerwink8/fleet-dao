// 拼车窗口按时段的空档（jobs/carpool-window.ts，决定 0120）。时间全按北京时间写（固定时钟，不看真钟）。
// 2026-10-23 周五、10-24 周六、10-25 周日、10-26 周一、10-27 周二。
import { describe, expect, it } from 'vitest';
import {
  carpoolGapAt,
  DEFAULT_WINDOW_SCHEDULE,
  isWeekdayShanghai,
  stampShanghai,
  type WindowSchedule,
} from '../src/jobs/carpool-window.ts';

const bj = (s: string) => new Date(`${s.replace(' ', 'T')}:00+08:00`);
const gapAt = (s: string, sched: WindowSchedule = DEFAULT_WINDOW_SCHEDULE) => carpoolGapAt(bj(s), sched);
const inGap = (s: string, sched?: WindowSchedule) => gapAt(s, sched).inGap;

describe('空档：工作日凌晨拼车不开新请求', () => {
  it('周二到周五 01:30–05:30 在空档里，起点、终点按北京时间写明', () => {
    for (const day of ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) {
      const g = gapAt(`${day} 03:00`);
      expect(g.inGap).toBe(true);
      if (g.inGap) {
        expect(g.from).toEqual(bj(`${day} 01:30`));
        expect(g.until).toEqual(bj(`${day} 05:30`));
      }
    }
  });

  it('周一 03:30–05:30 在空档里（周末连着排窗口，上周五 05:30 起的最后一个窗口 03:30 清零）', () => {
    const g = gapAt('2026-10-26 04:00');
    expect(g.inGap).toBe(true);
    if (g.inGap) {
      expect(g.from).toEqual(bj('2026-10-26 03:30'));
      expect(g.until).toEqual(bj('2026-10-26 05:30'));
    }
    expect(inGap('2026-10-26 02:00')).toBe(false);
  });

  it('周六、周日全天不限；周五晚上到周一 03:30 之前不限', () => {
    for (const t of [
      '2026-10-24 00:00',
      '2026-10-24 02:00',
      '2026-10-24 04:00',
      '2026-10-25 01:30',
      '2026-10-25 03:30',
      '2026-10-25 05:00',
      '2026-10-23 23:59',
      '2026-10-26 03:29',
    ]) {
      expect(inGap(t), t).toBe(false);
    }
  });

  it('周五 05:30 之后到周六凌晨不是空档（周五 01:30–05:30 才是）', () => {
    expect(inGap('2026-10-30 02:00')).toBe(true);
    expect(inGap('2026-10-30 05:30')).toBe(false);
    expect(inGap('2026-10-30 23:00')).toBe(false);
    expect(inGap('2026-10-31 02:00')).toBe(false);
  });

  it('白天、晚上不在空档里，下一个空档给出起止', () => {
    const g = gapAt('2026-10-27 12:00');
    expect(g.inGap).toBe(false);
    if (!g.inGap) {
      expect(g.next?.from).toEqual(bj('2026-10-28 01:30'));
      expect(g.next?.until).toEqual(bj('2026-10-28 05:30'));
    }
    const fri = gapAt('2026-10-30 12:00');
    if (!fri.inGap) expect(fri.next?.from).toEqual(bj('2026-11-02 03:30'));
  });

  it('边界整点：起点在、前一分钟不在；终点（锚点）不在、前一分钟在', () => {
    expect(inGap('2026-10-27 01:29')).toBe(false);
    expect(inGap('2026-10-27 01:30')).toBe(true);
    expect(inGap('2026-10-27 05:29')).toBe(true);
    expect(inGap('2026-10-27 05:30')).toBe(false);
    expect(inGap('2026-10-26 03:29')).toBe(false);
    expect(inGap('2026-10-26 03:30')).toBe(true);
    expect(inGap('2026-10-26 05:30')).toBe(false);
  });

  it('按北京时间判，不按 UTC：UTC 周日 17:30 是北京周一 01:30，UTC 周一 20:00 已是北京周二 04:00', () => {
    expect(carpoolGapAt(new Date('2026-10-25T17:30:00Z')).inGap).toBe(false); // 周一 01:30，还没到 03:30
    expect(carpoolGapAt(new Date('2026-10-25T19:30:00Z')).inGap).toBe(true); // 周一 03:30
    expect(carpoolGapAt(new Date('2026-10-26T20:00:00Z')).inGap).toBe(true); // 周二 04:00
  });
});

describe('参数可配：锚点、窗口长度、哪天算工作日', () => {
  it('锚点改成 06:00：周二空档变成 02:00–06:00，周一变成 04:00–06:00', () => {
    const s = { ...DEFAULT_WINDOW_SCHEDULE, anchorMinutes: 6 * 60 };
    const g = gapAt('2026-10-27 03:00', s);
    expect(g.inGap && g.from).toEqual(bj('2026-10-27 02:00'));
    expect(g.inGap && g.until).toEqual(bj('2026-10-27 06:00'));
    expect(inGap('2026-10-27 05:45', s)).toBe(true);
    expect(inGap('2026-10-27 06:00', s)).toBe(false);
    const mon = gapAt('2026-10-26 04:30', s);
    expect(mon.inGap && mon.from).toEqual(bj('2026-10-26 04:00'));
  });

  it('窗口长度整除 24 小时（4、6 小时）没有空档；7 小时则空档起点往前挪（24 除以 7 余 3 小时）', () => {
    const four = { ...DEFAULT_WINDOW_SCHEDULE, lengthMs: 4 * 3_600_000 };
    expect(inGap('2026-10-27 03:00', four)).toBe(false);
    const six = { ...DEFAULT_WINDOW_SCHEDULE, lengthMs: 6 * 3_600_000 };
    expect(inGap('2026-10-27 04:00', six)).toBe(false); // 24 小时正好 4 个 6 小时，周二没有空档
    const seven = { ...DEFAULT_WINDOW_SCHEDULE, lengthMs: 7 * 3_600_000 };
    const g = gapAt('2026-10-27 04:00', seven);
    expect(g.inGap && g.from).toEqual(bj('2026-10-27 02:30')); // 24 mod 7 = 3
  });

  it('换 isWorkday（节假日只改这一处）：周二当休息日，周三的空档从周一的锚点往后排', () => {
    const tueOff: WindowSchedule = {
      ...DEFAULT_WINDOW_SCHEDULE,
      isWorkday: (d) =>
        isWeekdayShanghai(d) && d !== Math.floor(bj('2026-10-27 12:00').getTime() / 86_400_000),
    };
    // 周二不是工作日：周二凌晨不限；周三的上一个工作日是周一，相隔 48 小时，48 mod 5 = 3，空档 02:30–05:30
    expect(inGap('2026-10-27 03:00', tueOff)).toBe(false);
    const wed = gapAt('2026-10-28 03:00', tueOff);
    expect(wed.inGap && wed.from).toEqual(bj('2026-10-28 02:30'));
  });

  it('一个工作日都没有：没有空档，写明原因，不当成一直在空档里', () => {
    const none = { ...DEFAULT_WINDOW_SCHEDULE, isWorkday: () => false };
    const g = gapAt('2026-10-27 03:00', none);
    expect(g.inGap).toBe(false);
    expect(g.inGap === false && g.why).toContain('没有工作日');
  });

  it('【故意造出失败】锚点或窗口长度不合法：抛错，不静默当成没有空档', () => {
    expect(() => gapAt('2026-10-27 03:00', { ...DEFAULT_WINDOW_SCHEDULE, anchorMinutes: 24 * 60 })).toThrow(
      '锚点',
    );
    expect(() => gapAt('2026-10-27 03:00', { ...DEFAULT_WINDOW_SCHEDULE, anchorMinutes: 1.5 })).toThrow();
    expect(() => gapAt('2026-10-27 03:00', { ...DEFAULT_WINDOW_SCHEDULE, lengthMs: 0 })).toThrow('长度');
    expect(() => carpoolGapAt(new Date(Number.NaN))).toThrow();
  });

  it('stampShanghai 写北京时间', () => {
    expect(stampShanghai(bj('2026-10-27 05:30'))).toBe('10-27 05:30（北京时间）');
  });
});
