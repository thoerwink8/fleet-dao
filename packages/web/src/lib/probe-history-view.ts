// 渠道状态页上探针历史怎么说（#1139、#1638、#1798 片 7）。格子的颜色和这几句在页面上对得上：
// 绿通过、红不通、橙疑似换模型、「在等」色连通但额度耗尽（#2939）、黄没探。
import type {
  ProbeHistoryCell,
  ProbeHistoryResult,
  RouteProbeKind,
  RouteProbeTrigger,
} from '@fleet-dao/shared';
import type { Route } from '../api/types';
import { formatDateTime } from './format';
import type { Tone } from './status';

/**
 * 一次探测的结论。疑似换模型 = 身份题说出了旧答案（checkPassed === false）；它不是普通不通，颜色单独一种。
 * 额度耗尽 = 连通（passed）但后端明说 quotaExhausted === true：连接是通的，只是此刻额度用完了；缺字段的老行不算。
 */
export type ProbeKind = ProbeHistoryResult | 'doubt' | 'quota';

export function probeKind(
  cell: Pick<ProbeHistoryCell, 'result' | 'checkPassed'> & { quotaExhausted?: boolean | undefined },
): ProbeKind {
  if (cell.result === 'failed' && cell.checkPassed === false) return 'doubt';
  if (cell.result === 'passed' && cell.quotaExhausted === true) return 'quota';
  return cell.result;
}

/** 疑似换模型没有对应的状态色（tone），用 doubt 标。 */
export const PROBE_KIND_WORD: Record<ProbeKind, { label: string; tone: Tone | 'doubt' }> = {
  passed: { label: '通过', tone: 'done' },
  failed: { label: '不通', tone: 'fail' },
  doubt: { label: '疑似换模型', tone: 'doubt' },
  quota: { label: '连通但额度耗尽', tone: 'wait' },
  not_probed: { label: '没探', tone: 'stall' },
};

// 原来的 PROBE_KIND_BG（格子底色映射）一处也没在用，已删（决定 0121 第 2 条那条改动顺手减掉的死代码）。
// 探测格子的颜色统一走 StatusBadge / LevelDot，按 PROBE_KIND_WORD 的 tone 取色。

/** 额度耗尽的重置时间：上游明确给了才写时刻，没给就写没给（不从「约 20 分钟」之类推算）。 */
export function quotaResetText(resetsAt: string | undefined): string {
  return resetsAt ? `预计 ${formatDateTime(resetsAt)} 重置` : '重置时间上游没给';
}

/** 格子、记录行共用的结论词：额度耗尽的带上重置说明，其余照 PROBE_KIND_WORD。 */
export function probeWord(cell: Parameters<typeof probeKind>[0] & { resetsAt?: string | undefined }): string {
  const kind = probeKind(cell);
  return kind === 'quota'
    ? `${PROBE_KIND_WORD.quota.label}（${quotaResetText(cell.resetsAt)}）`
    : PROBE_KIND_WORD[kind].label;
}

/** 这一格就是路由目录里「当前探针」那一次吗（相差不到 1 分钟算同一次）。 */
export function isCurrentProbe(
  cell: Pick<ProbeHistoryCell, 'probedAt'> | undefined,
  probe: Route['probe'],
): boolean {
  return (
    cell !== undefined &&
    probe !== undefined &&
    Math.abs(Date.parse(cell.probedAt) - Date.parse(probe.at)) < 60_000
  );
}

/**
 * 此刻额度耗尽的路由：只认和路由当前探针同一次的最新记录（latestByRoute），探针已经有更新的结果了，
 * 旧的额度记录不再作数。目录里探针不是「通」的路由也不算（额度记录只会出在连通的探测上）。
 */
export function currentQuotaCells(
  latestByRoute: readonly ProbeHistoryCell[],
  routes: readonly Pick<Route, 'id' | 'probe'>[],
): Map<string, ProbeHistoryCell> {
  const out = new Map<string, ProbeHistoryCell>();
  for (const route of routes) {
    const cell = latestByRoute.find((c) => c.routeId === route.id);
    if (
      cell &&
      probeKind(cell) === 'quota' &&
      route.probe?.state === 'ok' &&
      isCurrentProbe(cell, route.probe)
    )
      out.set(route.id, cell);
  }
  return out;
}

/** 探测种类的白话：连通（只回 pong）/ 身份题（pong 加一道知识截止期附近的事实题）。 */
export const PROBE_TYPE_NAME: Record<RouteProbeKind, string> = { ping: '连通', identity: '身份题' };

/** 谁触发的探测。 */
export const PROBE_TRIGGER_NAME: Record<RouteProbeTrigger, string> = {
  scheduled: '定时',
  dispatch: '派前',
  manual: '人点',
  break: '断链',
  'org-switch': '切号',
};

/** 老记录（算术题时代）：没有种类、但带着题。照原样显示，标「旧版降智题」。 */
export function isLegacyQuizCell(cell: Pick<ProbeHistoryCell, 'kind' | 'checkQuestion'>): boolean {
  return !cell.kind && cell.checkQuestion !== null;
}

/** 这一行的种类和触发者，一句话：「身份题 · 派前」。老行没有的段不写。 */
export function probeCellSource(cell: Pick<ProbeHistoryCell, 'kind' | 'trigger'>): string {
  return [
    cell.kind ? PROBE_TYPE_NAME[cell.kind] : undefined,
    cell.trigger ? PROBE_TRIGGER_NAME[cell.trigger] : undefined,
  ]
    .filter((x): x is string => x !== undefined)
    .join(' · ');
}

/** 最近一次身份题说出旧答案的路由：这些路由此刻是「疑似换模型」（latestByRoute 每条路由只有它自己最近一次）。 */
export function identityMismatchRoutes(latestByRoute: readonly ProbeHistoryCell[]): Set<string> {
  return new Set(latestByRoute.filter((c) => probeKind(c) === 'doubt').map((c) => c.routeId));
}

/** 耗时。没量到不写 0；没探的写「没真探」。 */
export function formatProbeMs(ms: number | null, result?: ProbeHistoryResult): string {
  if (ms === null) return result === 'not_probed' ? '没真探' : '没量到';
  const sec = ms / 1000;
  return `${sec.toFixed(sec < 10 ? 1 : 0)} 秒`;
}

/** 可用率。一条真探都没有不写 0% 或 100%。 */
export function formatAvailability(passed: number, attempted: number): string {
  if (attempted === 0) return '还没有真探';
  const raw = Math.round((passed / attempted) * 1000) / 10;
  const pct = Number.isInteger(raw) ? String(raw) : raw.toFixed(1);
  return `${pct}%（${passed}/${attempted}）`;
}

/**
 * 渠道详情里「探测记录」那份列表：本渠道近 60 次真探，加上每条路由自己的最近一次（挤出 60 格的也补上）和没真探的记录，
 * 按 id 去重，从新到旧（时刻晚的在前；同一时刻 id 大的在前）。
 */
export function probeLogRows(
  cells: readonly ProbeHistoryCell[],
  latestByRoute: readonly ProbeHistoryCell[],
  channelId: string,
  skipped: readonly ProbeHistoryCell[] = [],
): ProbeHistoryCell[] {
  const byId = new Map<number, ProbeHistoryCell>();
  for (const cell of skipped) byId.set(cell.id, cell);
  for (const cell of cells) byId.set(cell.id, cell);
  for (const cell of latestByRoute) if (cell.channelId === channelId) byId.set(cell.id, cell);
  return [...byId.values()].sort((a, b) => Date.parse(b.probedAt) - Date.parse(a.probedAt) || b.id - a.id);
}

/** 探测记录分两堆（#1748）：真探的（通过、不通、疑似换模型）摆在上面，没真探的（没探）折起来，不把真探埋在下面。 */
export function splitProbeRows(rows: readonly ProbeHistoryCell[]): {
  real: ProbeHistoryCell[];
  skipped: ProbeHistoryCell[];
} {
  return {
    real: rows.filter((c) => c.result !== 'not_probed'),
    skipped: rows.filter((c) => c.result === 'not_probed'),
  };
}
