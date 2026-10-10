// 渠道状态页上探针历史怎么说（#1139、#1638）。格子的颜色和这几句在页面上对得上：
// 绿通过、红不通、橙疑似降智、黄没探。
import type { ProbeHistoryCell, ProbeHistoryResult } from '@fleet-dao/shared';
import type { Tone } from './status';

/** 一次探测的结论。疑似降智 = 探通了，但降智题答错了（checkPassed === false）；它不是不通，颜色单独一种。 */
export type ProbeKind = ProbeHistoryResult | 'doubt';

export function probeKind(cell: Pick<ProbeHistoryCell, 'result' | 'checkPassed'>): ProbeKind {
  if (cell.result === 'failed' && cell.checkPassed === false) return 'doubt';
  return cell.result;
}

/** 疑似降智没有对应的状态色（tone），用 doubt 标。 */
export const PROBE_KIND_WORD: Record<ProbeKind, { label: string; tone: Tone | 'doubt' }> = {
  passed: { label: '通过', tone: 'done' },
  failed: { label: '不通', tone: 'fail' },
  doubt: { label: '疑似降智', tone: 'doubt' },
  not_probed: { label: '没探', tone: 'stall' },
};

/** 格子的底色。没探用停滞黄，不通用失败红，疑似降智用橙，三色分开。 */
export const PROBE_KIND_BG: Record<ProbeKind, string> = {
  passed: 'bg-st-done',
  failed: 'bg-st-fail',
  doubt: 'bg-st-doubt',
  not_probed: 'bg-st-stall',
};

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
 * 渠道详情里「探测记录」那份列表：本渠道近 60 格，加上每条路由自己的最近一次（挤出 60 格的也补上），
 * 按 id 去重，从新到旧（时刻晚的在前；同一时刻 id 大的在前）。
 */
export function probeLogRows(
  cells: readonly ProbeHistoryCell[],
  latestByRoute: readonly ProbeHistoryCell[],
  channelId: string,
): ProbeHistoryCell[] {
  const byId = new Map<number, ProbeHistoryCell>();
  for (const cell of cells) byId.set(cell.id, cell);
  for (const cell of latestByRoute) if (cell.channelId === channelId) byId.set(cell.id, cell);
  return [...byId.values()].sort((a, b) => Date.parse(b.probedAt) - Date.parse(a.probedAt) || b.id - a.id);
}
