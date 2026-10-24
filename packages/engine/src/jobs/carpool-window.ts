// 拼车 5 小时窗口的「按时段」空档（决定 0120，#3687 批次 5）。纯函数：只看传进来的时刻，不碰库、不碰网、不看钟。
//
// 规矩：工作日（周一到周五，北京时间）每天 05:30 要点着新窗口，上班钉的两次清零才落在 10:30、15:30。窗口一清零就点下一个，
// 点了会盖住下一个工作日锚点的就不点：从上一个工作日的锚点起一个接一个排窗口（锚点 + k × 窗口长度），最后一个清零的时刻
// 到下一个工作日锚点之间就是空档，空档里拼车不能有新请求，会话用户挂到独享。
//   周二到周五：前一天 05:30 + 20 小时 = 01:30，空档 01:30–05:30；
//   周一：上周五 05:30 + 70 小时 = 03:30，空档 03:30–05:30（周末连着排，不限）。
// 空档起点 = 下一个工作日锚点 − ((它与上一个工作日锚点相隔) 除以窗口长度的余数)；余数为 0 = 窗口正好在锚点清零，没有空档。
//
// 改这里之前必须知道：
// - 不写死 01:30 这些钟点：锚点、窗口长度、哪天算工作日都是参数。以后加节假日只换 isWorkday（传一张表进来），别的不动。
// - 时间一律按北京时间（Asia/Shanghai，没有夏令时，固定 UTC+8）判。
// - 区间左闭右开：恰好是空档起点算在空档里，恰好是锚点算空档已过。
// - 找不到工作日（isWorkday 一直为假，14 天内没有）= 没有空档（返回 inGap=false，why 写明），不当成一直在空档里。

export interface WindowSchedule {
  /** 窗口锚点：北京时间当天 0 点起第几分钟，默认 330 = 05:30。 */
  anchorMinutes: number;
  /** 窗口长度（毫秒），默认 5 小时。 */
  lengthMs: number;
  /** 这一天（北京时间日历日，距 1970-01-01 的天数）算不算工作日；默认周一到周五。 */
  isWorkday: (dayIndex: number) => boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 北京时间比 UTC 快 8 小时，不用夏令时。 */
const SHANGHAI_OFFSET_MS = 8 * HOUR;
const SEARCH_DAYS = 14;

/** 北京时间的日历日（距 1970-01-01 的天数，1970-01-01 是周四）是不是周一到周五。 */
export function isWeekdayShanghai(dayIndex: number): boolean {
  const dow = (((dayIndex + 4) % 7) + 7) % 7; // 0 周日 … 6 周六
  return dow >= 1 && dow <= 5;
}

export const DEFAULT_WINDOW_SCHEDULE: Readonly<WindowSchedule> = Object.freeze({
  anchorMinutes: 5 * 60 + 30,
  lengthMs: 5 * HOUR,
  isWorkday: isWeekdayShanghai,
});

export type WindowGap =
  | { inGap: true; from: Date; until: Date }
  | {
      inGap: false;
      /** 下一个空档的起止；找不到工作日、没有空档时没有。 */
      next?: { from: Date; until: Date };
      why?: string;
    };

const dayOf = (ms: number) => Math.floor((ms + SHANGHAI_OFFSET_MS) / DAY);
const anchorAt = (dayIndex: number, s: WindowSchedule) =>
  dayIndex * DAY - SHANGHAI_OFFSET_MS + s.anchorMinutes * 60_000;

/** 北京时间 MM-DD HH:mm，给提醒和理由用。 */
export function stampShanghai(d: Date): string {
  const t = new Date(d.getTime() + SHANGHAI_OFFSET_MS).toISOString();
  return `${t.slice(5, 10)} ${t.slice(11, 16)}（北京时间）`;
}

/** now 落在拼车空档里没有。参数不合法（锚点不在 0–1439、窗口长度不是正数）抛错，不静默当成没有空档。 */
export function carpoolGapAt(now: Date, schedule: WindowSchedule = DEFAULT_WINDOW_SCHEDULE): WindowGap {
  const s = schedule;
  if (!Number.isInteger(s.anchorMinutes) || s.anchorMinutes < 0 || s.anchorMinutes >= 24 * 60) {
    throw new RangeError(`拼车窗口锚点要是 0–1439 的整数分钟，拿到 ${s.anchorMinutes}`);
  }
  if (!Number.isFinite(s.lengthMs) || s.lengthMs <= 0) {
    throw new RangeError(`拼车窗口长度要是正数毫秒，拿到 ${s.lengthMs}`);
  }
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new RangeError('拼车空档：当前时刻不是合法时间');
  const today = dayOf(t);
  // 下一个工作日锚点：严格晚于现在的第一个
  let nextDay: number | null = null;
  for (let d = today; d <= today + SEARCH_DAYS; d += 1) {
    if (s.isWorkday(d) && anchorAt(d, s) > t) {
      nextDay = d;
      break;
    }
  }
  if (nextDay === null) return { inGap: false, why: `往后 ${SEARCH_DAYS} 天没有工作日，没有空档` };
  // 上一个工作日锚点：往回找第一个
  let prevDay: number | null = null;
  for (let d = nextDay - 1; d >= nextDay - SEARCH_DAYS; d -= 1) {
    if (s.isWorkday(d)) {
      prevDay = d;
      break;
    }
  }
  if (prevDay === null) return { inGap: false, why: `往前 ${SEARCH_DAYS} 天没有工作日，没有空档` };
  const until = anchorAt(nextDay, s);
  const rest = (until - anchorAt(prevDay, s)) % s.lengthMs;
  if (rest === 0) return { inGap: false, why: '窗口正好在下一个工作日锚点清零，没有空档' };
  const from = until - rest;
  const gap = { from: new Date(from), until: new Date(until) };
  return t >= from ? { inGap: true, ...gap } : { inGap: false, next: gap };
}
