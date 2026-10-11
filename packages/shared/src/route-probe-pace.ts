// 定时路由探针的退避节奏（#1424）。派前探测、人点「立即探测」不看这里：它们该探还探。
// 不通：连着不通 1、2、3、4、5… 次，重探间隔 15、30、60、120、240 分钟，封顶 240。一次探通回到原来的间隔。
// 活跃 / 不活跃 / 不在用三档的成功间隔在引擎 jobs/route-probe.ts（#1798 片 3），这里只管退避。
// 节奏读 routes 上的结构化列（probe_tier、probe_next_at、probe_fail_streak、probe_kind），选路和页面不再从原文里抠（#1843 删了只为抠原文存在的函数，只留引擎兜底用的 probeFailStreak）。
// 时刻按北京时间写进结论（驾驶舱在中国看的是同一点钟）。格式认不出就抛，不编一个钟点。

import type { RouteProbeKind, RouteProbeTier } from './domain.ts';

export const ROUTE_PROBE_BACKOFF_MINUTES = [15, 30, 60, 120, 240] as const;

const STREAK = /连着不通\s*(\d+)\s*次/;
const NOTICE = /退避中，下次约 \d{2}:\d{2} 再探/;

/**
 * 库里这一行的节奏列写过没有（#1798 片 2 的 routes.probe_tier / probe_next_at / probe_fail_streak / probe_kind）。
 * 引擎写的时候四列一起写，但 probe_fail_streak 有默认 0：认不出「老行没写过」和「写过 0（探通清零）」。
 * 所以认得宽一点：另外三列有值，或 fail_streak 不是 0，就算写过；都没写过 = 老行。
 * 接口据此决定给不给这几列：老行一个都不给，不拿默认 0 顶上（片 6）。判法只在这里一处，db、api 不各判一遍。
 */
export function probePaceWritten(r: {
  probeTier?: RouteProbeTier | null;
  probeNextAt?: Date | null;
  probeFailStreak?: number | null;
  probeKind?: RouteProbeKind | null;
}): boolean {
  if (r.probeTier != null || r.probeNextAt != null || r.probeKind != null) return true;
  return (r.probeFailStreak ?? 0) !== 0;
}

/**
 * 原文里的「连着不通 N 次」。没写次数回 null（不是 0：没写 ≠ 一次都没失败）。
 * 只剩引擎定时轮一处用：probe_fail_streak 列是 0、上一次又是不通时，拿原文兜底（老行；0054 迁移已按原文回填过列）。
 */
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

/** 这一次探针原文里的「退避中，下次约 HH:MM 再探」（整池暂停的提醒照抄给人看）；没有这句回 null。 */
export function probeBackoffNotice(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return NOTICE.exec(detail)?.[0] ?? null;
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
