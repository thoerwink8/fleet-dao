// 渠道状态页上探针历史怎么说（#1139、#1638、#1798 片 7）。格子的颜色和这几句在页面上对得上：
// 绿通过、红不通、橙疑似换模型、黄没探。
import type {
  ProbeHistoryCell,
  ProbeHistoryResult,
  RouteProbeKind,
  RouteProbeTrigger,
} from '@fleet-dao/shared';
import type { Tone } from './status';

/** 一次探测的结论。疑似换模型 = 身份题说出了旧答案（checkPassed === false）；它不是普通不通，颜色单独一种。 */
export type ProbeKind = ProbeHistoryResult | 'doubt';

export function probeKind(cell: Pick<ProbeHistoryCell, 'result' | 'checkPassed'>): ProbeKind {
  if (cell.result === 'failed' && cell.checkPassed === false) return 'doubt';
  return cell.result;
}

/** 疑似换模型没有对应的状态色（tone），用 doubt 标。 */
export const PROBE_KIND_WORD: Record<ProbeKind, { label: string; tone: Tone | 'doubt' }> = {
  passed: { label: '通过', tone: 'done' },
  failed: { label: '不通', tone: 'fail' },
  doubt: { label: '疑似换模型', tone: 'doubt' },
  not_probed: { label: '没探', tone: 'stall' },
};

/** 格子的底色。没探用停滞黄，不通用失败红，疑似换模型用橙，三色分开。 */
export const PROBE_KIND_BG: Record<ProbeKind, string> = {
  passed: 'bg-st-done',
  failed: 'bg-st-fail',
  doubt: 'bg-st-doubt',
  not_probed: 'bg-st-stall',
};

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
  return cell.kind === null && cell.checkQuestion !== null;
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
