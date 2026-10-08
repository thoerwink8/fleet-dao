// 给人看的字：时间、时长、截断都过这里（卡片上的内部代号由 cards.ts 的 checkCard 拦）。

const TZ = 'Asia/Shanghai';
/** 北京无夏令时，固定 UTC+8。不用 Intl 的 hour12:false：那条交给运行时选小时周期，有的会选 h24，午夜显示成 24:xx。 */
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 北京时间的日期，例如 2026-09-25。 */
export function beijingDay(ms: number): string {
  return dayFmt.format(new Date(ms));
}

/** 北京时间的「时:分」，例如 14:02。取 0–23 时，午夜是 00。 */
export function beijingClock(ms: number): string {
  const shifted = new Date(ms + BEIJING_OFFSET_MS);
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  // 认不出的时刻跟以前一样抛，不把 NaN 拼进飞书消息。
  if (Number.isNaN(hour) || Number.isNaN(minute)) throw new RangeError('Invalid time value');
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 今天的只写时刻，别的日子带上月日：「14:02」「09-24 14:02」。 */
export function when(iso: string | number, nowMs: number): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return '时间不明';
  const day = beijingDay(ms);
  return day === beijingDay(nowMs) ? beijingClock(ms) : `${day.slice(5)} ${beijingClock(ms)}`;
}

/** 「3 分钟」「2 小时」「5 天」。 */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/**
 * 截断给人看的长文字，保证卡片不超 30 KB。不截在代理对中间（emoji 这类）：半个代理对交给后端，
 * 写库时会被换成 � 或整条被拒。
 */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  let end = max - 1;
  const last = t.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${t.slice(0, end)}…`;
}
