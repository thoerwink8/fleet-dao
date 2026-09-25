// 数字与时间的中文说法。显示时外面再套等宽字体（class="num"）。

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const TIME = { SEC, MIN, HOUR, DAY } as const;

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** 42 秒 / 12 分钟 / 1 小时 5 分 / 2 天 3 小时 */
export function formatDuration(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (v < MIN) return `${Math.max(1, Math.round(v / SEC))} 秒`;
  if (v < HOUR) return `${Math.floor(v / MIN)} 分钟`;
  if (v < DAY) {
    const h = Math.floor(v / HOUR);
    const m = Math.floor((v % HOUR) / MIN);
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  return h ? `${d} 天 ${h} 小时` : `${d} 天`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} ${formatClock(iso)}`;
}

/** 过去的时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 14:20 / 3 天前 / 9月2日 */
export function formatAgo(iso: string, now: number): string {
  const diff = now - Date.parse(iso);
  if (diff < 0) return formatIn(iso, now);
  if (diff < 45 * SEC) return '刚刚';
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MIN))} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 2 * DAY) return `昨天 ${formatClock(iso)}`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return formatDate(iso);
}

/** 将来的时间：45 秒后 / 12 分钟后 / 2 小时 13 分后 / 3 天 4 小时后 */
export function formatIn(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  if (diff <= 0) return '到点了';
  if (diff < MIN) return `${Math.ceil(diff / SEC)} 秒后`;
  if (diff < HOUR) return `${Math.ceil(diff / MIN)} 分钟后`;
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    const m = Math.floor((diff % HOUR) / MIN);
    return m ? `${h} 小时 ${m} 分后` : `${h} 小时后`;
  }
  const d = Math.floor(diff / DAY);
  const h = Math.floor((diff % DAY) / HOUR);
  return h ? `${d} 天 ${h} 小时后` : `${d} 天后`;
}

/** 远一点的将来只说天数：19 天后；两天以内照常精确到分钟。 */
export function formatInDays(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  if (diff < 2 * DAY) return formatIn(iso, now);
  return `${Math.round(diff / DAY)} 天后`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** 8,200 / 3.1 万 / 1.2 亿 */
export function formatCount(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 100_000_000) return `${(n / 10_000).toFixed(1)} 万`;
  return `${(n / 100_000_000).toFixed(1)} 亿`;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

/** 两个 ISO 时间之间的毫秒数；end 缺省用 now。 */
export function span(startIso: string | undefined, endIso: string | undefined, now: number): number {
  if (!startIso) return 0;
  const end = endIso ? Date.parse(endIso) : now;
  return Math.max(0, end - Date.parse(startIso));
}
