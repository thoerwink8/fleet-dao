// 发送出口上的两道闸：免打扰时段、每天「求人」卡的预算。都按北京时间算。
import { beijingDay } from './words.ts';

const DAY = 24 * 60 * 60 * 1000;
/** 北京时间 = UTC+8，没有夏令时。 */
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

export interface QuietHours {
  /** HH:MM，北京时间。start 比 end 晚表示跨夜，例如 23:00–08:00。 */
  start: string;
  end: string;
}

/**
 * 现在在免打扰里就返回结束的时刻（毫秒），不在返回 null。start 和 end 相同视为没设。
 * 格式认不出就抛错：不能当成「没设免打扰」半夜照发。
 */
export function quietUntil(quiet: QuietHours | null, nowMs: number): number | null {
  if (!quiet) return null;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === null || end === null) {
    throw new Error(`免打扰时段格式认不出：${JSON.stringify(quiet)}（要 HH:MM）`);
  }
  if (start === end) return null;
  const local = nowMs + BEIJING_OFFSET;
  const midnight = local - (((local % DAY) + DAY) % DAY);
  const m = Math.floor((local - midnight) / 60_000);
  const at = (day: number, mins: number) => midnight + day * DAY + mins * 60_000 - BEIJING_OFFSET;
  if (start < end) return m >= start && m < end ? at(0, end) : null;
  if (m >= start) return at(1, end);
  if (m < end) return at(0, end);
  return null;
}

function minutes(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** 每天最多发几张「求人」的卡（要人拍 + AI 追问）。旧系统 5 天发了 27 张、只有 4 张真要拍——超了要报，不能接着推。 */
export class DailyBudget {
  private readonly limit: number;
  private day = '';
  private used = 0;
  private alerted = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  private roll(nowMs: number): void {
    const today = beijingDay(nowMs);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
      this.alerted = false;
    }
  }

  /** 占一个名额；没名额返回 false。 */
  take(nowMs: number): boolean {
    this.roll(nowMs);
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }

  /** 发送失败，名额还回去。 */
  giveBack(nowMs: number): void {
    this.roll(nowMs);
    if (this.used > 0) this.used -= 1;
  }

  /** 今天第一次超预算返回 true（只提醒一次）。 */
  firstOverrun(nowMs: number): boolean {
    this.roll(nowMs);
    if (this.alerted) return false;
    this.alerted = true;
    return true;
  }

  usedToday(nowMs: number): number {
    this.roll(nowMs);
    return this.used;
  }
}
