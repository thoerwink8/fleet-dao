// 定时路由探针的省额度节奏（#1424）。派前探测、人点「立即探测」不看这里：它们该探还探。
// 不通：连着不通 1、2、3、4、5… 次，重探间隔 15、30、60、120、240 分钟，封顶 240。一次探通回到原来的间隔。
// 探通了、又不在它所在用途里开着的前 2 条：定时探针隔 60 分钟。这种执行方式本来隔得更久的不改短。
// 时刻按北京时间写进结论（驾驶舱在中国看的是同一点钟）。格式认不出就抛，不编一个钟点。

import { ROUTE_PROBE_EVERY_MINUTES, routeProbeEveryMinutes } from './web-api/routing.ts';

export const ROUTE_PROBE_BACKOFF_MINUTES = [15, 30, 60, 120, 240] as const;
/** 不在用途顺序前 2 位、又已经探通的，定时探针隔这么久再探。 */
export const ROUTE_PROBE_DEFER_MINUTES = 60;
/** 用途顺序里开着的前这么多条，保持原来的间隔。 */
export const ROUTE_PROBE_PRIMARY_COUNT = 2;

const STREAK = /连着不通\s*(\d+)\s*次/;
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
 * 原文写了连着不通几次：按退避那一档。写了「隔 60 分钟再探」：和执行方式自己的间隔取更长的。其余按执行方式。
 */
export function probeCadenceMinutes(hostId: string | undefined, detail: string | null | undefined): number {
  const streak = probeFailStreak(detail);
  if (streak !== null) return probeBackoffMinutes(streak);
  const hostEvery = routeProbeEveryMinutes(hostId);
  if (detail?.includes(`隔 ${ROUTE_PROBE_DEFER_MINUTES} 分钟再探`)) {
    return Math.max(hostEvery, ROUTE_PROBE_DEFER_MINUTES);
  }
  return hostEvery;
}

/**
 * 驾驶舱「下次大约几点再探」用的间隔。探通过的按上面那一档；不通但原文没写次数的仍按每轮（15 分钟），
 * 不把没写次数的慢执行方式一下子拉成它探通时的长间隔。
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
