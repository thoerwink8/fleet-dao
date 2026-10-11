// 路由行上「上次探测」「下次探测」两句怎么说（#1798 片 7，方案 3.6）。
// 只读库里的结构化列：probeTier（活跃 / 不活跃 / 不在用）、probeNextAt、probeFailStreak、probeKind，
// 加探测记录里最近一次的触发者；不从探针原文里抠任何东西。

import type { RouteProbeKind, RouteProbeTier, RouteProbeTrigger } from '@fleet-dao/shared';
import { formatAgo, formatClock, TIME } from './format';
import { PROBE_TRIGGER_NAME, PROBE_TYPE_NAME } from './probe-history-view';
import { PROBE_INTERRUPT_GRACE_MINUTES } from './route-state';

/** 三档的白话。unused 的间隔为空：不主动探。 */
export const PROBE_TIER_WORD: Record<RouteProbeTier, { label: string; every: string }> = {
  active: { label: '活跃', every: '每小时' },
  idle: { label: '不活跃', every: '每天' },
  unused: { label: '不在用', every: '' },
};

/** 上次探测那一句：「上次 12 分钟前 · 连通 · 定时」。种类、触发者库里没写的段不写，不拿默认值顶。 */
export function lastProbeLine(
  at: string,
  parts: { kind?: RouteProbeKind | null | undefined; trigger?: RouteProbeTrigger | undefined },
  now: number,
): string {
  return [
    `上次 ${formatAgo(at, now)}`,
    parts.kind ? PROBE_TYPE_NAME[parts.kind] : undefined,
    parts.trigger ? PROBE_TRIGGER_NAME[parts.trigger] : undefined,
  ]
    .filter((x): x is string => x !== undefined)
    .join(' · ');
}

/** 下次探测的钟点：今天只写钟点，明天写「明天 09:22」，再远加日期。 */
export function nextClockText(iso: string, now: number): string {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const diffDays = Math.round((day(Date.parse(iso)) - day(now)) / TIME.DAY);
  if (diffDays <= 0) return formatClock(iso);
  if (diffDays === 1) return `明天 ${formatClock(iso)}`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${formatClock(iso)}`;
}

export interface NextProbeLine {
  text: string;
  /** warn = 已到点还没探（20 分钟内）；fail = 检测中断；其余 normal。 */
  tone: 'normal' | 'warn' | 'fail';
}

/**
 * 下次探测那一句：
 * - 活跃：下次约 14:07（活跃，每小时）；不活跃：下次约 明天 09:22（不活跃，每天）；
 * - 不在用：不主动探（没用途在用）；退避中：退避中，连着不通 3 次，下次约 15:30；
 * - 晚于下次加 20 分钟还没探：检测中断，写本该几点探。
 * 节奏档库里没写（引擎还没走过钟）回 null，调用方写「没写」。
 */
export function nextProbeLine(
  r: {
    probeTier?: RouteProbeTier | undefined;
    probeNextAt?: string | undefined;
    probeFailStreak?: number | undefined;
  },
  now: number,
): NextProbeLine | null {
  if (r.probeTier === undefined) return null;
  if (r.probeTier === 'unused') return { text: '不主动探（没用途在用）', tone: 'normal' };
  if (r.probeNextAt === undefined) return null;
  const clock = nextClockText(r.probeNextAt, now);
  const late = now - Date.parse(r.probeNextAt);
  if (late > PROBE_INTERRUPT_GRACE_MINUTES * TIME.MIN) {
    return { text: `检测中断：本该 ${clock} 探，已过 ${Math.floor(late / TIME.MIN)} 分钟没探`, tone: 'fail' };
  }
  const word = PROBE_TIER_WORD[r.probeTier];
  const streak = r.probeFailStreak ?? 0;
  if (streak > 0) {
    return { text: `退避中，连着不通 ${streak} 次，下次约 ${clock}`, tone: late > 0 ? 'warn' : 'normal' };
  }
  if (late > 0)
    return { text: `下次 ${clock} 已到点，等这一轮钟（${word.label}，${word.every}）`, tone: 'warn' };
  return { text: `下次约 ${clock}（${word.label}，${word.every}）`, tone: 'normal' };
}
