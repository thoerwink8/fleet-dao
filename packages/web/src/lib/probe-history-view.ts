// 渠道状态页上探针历史怎么说（#1139）。格子的颜色和这几句在页面上对得上：绿通过、红不通、黄没探。
import type { ProbeHistoryResult } from '@fleet-dao/shared';
import type { Tone } from './status';

export const PROBE_RESULT_WORD: Record<ProbeHistoryResult, { label: string; tone: Tone }> = {
  passed: { label: '通过', tone: 'done' },
  failed: { label: '不通', tone: 'fail' },
  not_probed: { label: '没探', tone: 'stall' },
};

/** 格子的底色。没探用停滞黄，不通用失败红，两色分开。 */
export const PROBE_RESULT_BG: Record<ProbeHistoryResult, string> = {
  passed: 'bg-st-done',
  failed: 'bg-st-fail',
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
