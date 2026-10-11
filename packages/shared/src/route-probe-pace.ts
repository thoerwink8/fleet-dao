// 定时路由探针的退避节奏（#1424）。派前探测、人点「立即探测」不看这里：它们该探还探。
// 不通：连着不通 1、2、3、4、5… 次，重探间隔 15、30、60、120、240 分钟，封顶 240。一次探通回到原来的间隔。
// 活跃 / 不活跃 / 不在用三档的成功间隔在引擎 jobs/route-probe.ts（#1798 片 3），这里只管退避和从原文抠次数
// （选路、页面在片 6/7 改读结构化列之前还靠这份）。
// 时刻按北京时间写进结论（驾驶舱在中国看的是同一点钟）。格式认不出就抛，不编一个钟点。

import { ROUTE_PROBE_EVERY_MINUTES } from './web-api/routing.ts';

export const ROUTE_PROBE_BACKOFF_MINUTES = [15, 30, 60, 120, 240] as const;

const STREAK = /连着不通\s*(\d+)\s*次/;
/** 按需探测结论里固定的一句（历史行；片 8 删枚举前页面还认）。 */
export const ROUTE_PROBE_ON_DEMAND_MARK = '不主动探，要派给它时先探一次';

const NOTICE = /退避中，下次约 \d{2}:\d{2} 再探/;

/** 连着不通几次。原文没写次数回 null（不是 0：没写 ≠ 一次都没失败）。 */
export function probeFailStreak(detail: string | null | undefined): number | null {
  if (!detail) return null;
  const matched = STREAK.exec(detail);
  if (!matched?.[1]) return null;
  const n = Number(matched[1]);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

/** 连着不通这么多次之后，隔多少分钟再探。不到 1 次按第 1 档，超过末档封顶。 */
export function probeBackoffMinutes(streak: number): number {
  const steps = ROUTE_PROBE_BACKOFF_MINUTES;
  const index = Math.min(Math.max(Math.floor(streak), 1), steps.length) - 1;
  return steps[index] ?? steps[steps.length - 1] ?? 240;
}

/** 结论里给人看的那句。时刻是北京时间的 HH:MM。 */
export function probeBackoffPhrase(next: Date): string {
  const clock = shanghaiClock(next);
  return `退避中，下次约 ${clock} 再探`;
}

/** 原文里的「退避中，下次约 HH:MM 再探」；没有这句回 null。 */
export function probeBackoffNotice(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return NOTICE.exec(detail)?.[0] ?? null;
}

/**
 * 下次该探的时刻：上一次结论的时刻加上这一档的间隔。
 * 读不到时刻、或原文没有「连着不通 N 次」，回 null（调用方按到期该探，不跳过）。
 */
export function probeBackoffNextAt(probedAt: string | Date, detail: string | null | undefined): Date | null {
  const streak = probeFailStreak(detail);
  if (streak === null) return null;
  const at = probedAt instanceof Date ? probedAt.getTime() : Date.parse(probedAt);
  if (!Number.isFinite(at)) return null;
  return new Date(at + probeBackoffMinutes(streak) * 60_000);
}

/**
 * 这份结论对应的再探间隔（分钟）。
 * 原文写了连着不通几次：按退避那一档。其余按钟一轮（三档成功间隔由引擎写进 probe_next_at）。
 */
export function probeCadenceMinutes(_hostId: string | undefined, detail: string | null | undefined): number {
  const streak = probeFailStreak(detail);
  if (streak !== null) return probeBackoffMinutes(streak);
  return ROUTE_PROBE_EVERY_MINUTES;
}

/** 这份原文是不是「按需探测」的结论（状态 on_demand 的原文必带固定那一句）。按需的不算过期、不算检测中断。 */
export function isOnDemandDetail(detail: string | null | undefined): boolean {
  return !!detail && detail.includes(ROUTE_PROBE_ON_DEMAND_MARK);
}

/** 降智检测没过的原文起头那一句（引擎 real/route-probe.ts 的 probeVerdict 写的）。 */
export const ROUTE_PROBE_DEGRADED_MARK = '疑似降智';

/**
 * 这份探针原文说的是「疑似降智」（降智题答错、已按不在线处理）吗（#1748）。
 * 两种写法都认：直接是不通的结论（原文以「疑似降智」起头）；或按需探测接手后，原文里「上一次真探：不通，时刻（疑似降智……」。
 * 上一次真探是通的、或只是原文别处提到这四个字，都不算。
 */
export function isDegradedDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const text = detail.trim();
  if (text.startsWith(ROUTE_PROBE_DEGRADED_MARK)) return true;
  if (!text.includes(ROUTE_PROBE_ON_DEMAND_MARK)) return false;
  return new RegExp(`上一次真探：不通，[^（]*（${ROUTE_PROBE_DEGRADED_MARK}`).test(text);
}

/** 北京时间的「MM-DD HH:MM」；时间无效就抛，不编一个。 */
function shanghaiStamp(at: Date): string {
  const t = at.getTime();
  if (!Number.isFinite(t)) throw new Error('按需探测的时刻不是有效时间');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
}

const LAST_DETAIL_MAX = 120;

/**
 * 按需探测的结论原文：固定那一句，加上上一次真探的结果和时刻（北京时间）。上一次是 ok / failed 才算真探；
 * 没有、或上一次是没探（skipped、not_wired、按需）写「还没真探过」，不编。
 * （历史行与 mock 还用；引擎定时轮不再写 on_demand，#1798 片 3。）
 */
export function onDemandDetail(
  last: { state: string; at: Date; detail: string | null } | null | undefined,
): string {
  if (!last || (last.state !== 'ok' && last.state !== 'failed')) {
    return `${ROUTE_PROBE_ON_DEMAND_MARK}。还没真探过`;
  }
  const verdict = last.state === 'ok' ? '通' : '不通';
  const raw = (last.detail ?? '').replace(/\s+/g, ' ').trim();
  const clipped = raw.length > LAST_DETAIL_MAX ? `${raw.slice(0, LAST_DETAIL_MAX - 1)}…` : raw;
  return `${ROUTE_PROBE_ON_DEMAND_MARK}。上一次真探：${verdict}，${shanghaiStamp(last.at)}${clipped ? `（${clipped}）` : ''}`;
}

/**
 * 驾驶舱「下次大约几点再探」用的间隔。探通过的按上面那一档；不通但原文没写次数的仍按每轮（15 分钟）。
 */
export function probeNextEveryMinutes(
  hostId: string | undefined,
  state: string | undefined,
  detail: string | null | undefined,
): number {
  if (state === 'ok') return probeCadenceMinutes(hostId, detail);
  const streak = probeFailStreak(detail);
  if (streak !== null) return probeBackoffMinutes(streak);
  return ROUTE_PROBE_EVERY_MINUTES;
}

function shanghaiClock(at: Date): string {
  const t = at.getTime();
  if (!Number.isFinite(t)) throw new Error('探针退避的时刻不是有效时间');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '';
  if (!/^\d{2}$/.test(hh) || !/^\d{2}$/.test(mm)) {
    throw new Error(`探针退避的时刻格式认不出：${hh}:${mm}`);
  }
  return `${hh}:${mm}`;
}
