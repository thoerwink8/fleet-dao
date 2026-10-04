// 刷新耗时表（test-timings.json，test-split.ts 装箱用）：从主线一轮 ci.yml 的日志（`gh run view <id> --log`）里认出每个测试文件的耗时。
// 入口 bin/ci-timings.ts（`pnpm ci:timings`）。只在本机跑、结果进仓；CI 里不读 GitHub（#299：CI 的判定只看检出来的文件）。
// 改这里之前必须知道：
// - vitest 默认报告器每个文件一行 `✓ <文件> (N tests) 1234ms`（有跳过的写成 `(N tests | 1 skipped)`，慢的可能写成 `1.2s`），
//   带颜色转义码；`gh run view --log` 每行前面是「job 名<TAB>步骤名<TAB>时间戳 」。只认 job 名以 `test (` 开头的行：
//   lint job 里 docs 那步也跑 agents/test，量的是另一种机器负载，不能混进来。
// - 主线按「上次绿…这次」区间跑，一轮往往只跑一部分文件：没出现的文件沿用旧值，仓里已经没有的删掉。认出 0 个文件是失败，不写空表。
import { isTestFile, type Timings } from './test-split.ts';

// 颜色转义码：终端里是 ESC，GitHub 存的日志里是字面的「^[」两个字符，两种都去掉。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要去掉的就是终端颜色转义码
const ANSI = /(?:\x1b|\^\[)\[[0-9;?]*[A-Za-z]/g;
const FILE_LINE =
  /(?:^|\s)[✓✔√❯×✗↓]\s+(\S+\.test\.tsx?)\s+\((\d+) tests?[^)]*\)\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/;

/** 从 `gh run view --log` 的全文里认出每个测试文件的毫秒数（同一个文件出现几次取最大的）。 */
export function parseRunLog(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '');
    const job = line.split('\t')[0] ?? '';
    if (!job.startsWith('test (')) continue;
    const m = FILE_LINE.exec(line);
    if (!m) continue;
    const file = m[1] as string;
    if (!isTestFile(file)) continue;
    const value = Number(m[3]) * (m[4] === 's' ? 1000 : 1);
    out.set(file, Math.max(out.get(file) ?? 0, Math.round(value)));
  }
  return out;
}

/**
 * 几轮日志各自认出来的耗时，一个文件取中位数（偶数个取偏高的那个，宁可高估不低估）：单轮里某个文件会因机器抖动慢一倍
 * （2026-10-04 实测 watchdog.test.ts 同一个文件两轮 5.3 秒和 11.7 秒），装箱只该信稳定的那部分。只在一部分轮里出现的文件，
 * 按出现的那几轮取（全跑的 PR 才带全部文件，按改动跑的轮次只带一部分）。至少要有一轮，没有就返回 undefined（入口退出 2）。
 */
export function medianOfRuns(runs: readonly ReadonlyMap<string, number>[]): Map<string, number> | undefined {
  if (runs.length === 0) return undefined;
  const all = new Map<string, number[]>();
  for (const run of runs) for (const [f, ms] of run) all.set(f, [...(all.get(f) ?? []), ms]);
  const out = new Map<string, number>();
  for (const [f, values] of all) {
    const s = [...values].sort((a, b) => a - b);
    out.set(f, s[Math.floor(s.length / 2)] as number);
  }
  return out;
}

/** 耗时表文件头上那句说明（renderTimings 写进去；test/test-timings.test.ts 核对仓里那份就是它写出来的样子）。 */
export const TIMINGS_NOTE =
  'CI 测试按耗时装箱用的耗时表（packages/conventions/src/test-split.ts）：测试文件 → vitest 报的毫秒数（4 核运行机上并行跑时量的，几轮 CI 日志取中位数）。只影响分得匀不匀，不影响跑不跑：表里没有的按中位数估。用 pnpm ci:timings（可重复给 --run）从 CI 日志刷新，别手改。';

/** 写回仓里的样子：说明、来源、按路径排好序的文件表，两格缩进、末尾换行。 */
export function renderTimings(t: Timings): string {
  const files = Object.fromEntries(Object.entries(t.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ 说明: TIMINGS_NOTE, source: t.source, files }, null, 2)}\n`;
}

export interface MergeResult {
  timings: Timings;
  updated: number;
  kept: number;
  dropped: string[];
  added: number;
}

/** 新量的盖住旧的；这一轮没跑的沿用旧值；仓里已经没有的（不在 existing 里）删掉。键排好序。 */
export function mergeTimings(
  old: Timings | undefined,
  measured: ReadonlyMap<string, number>,
  existing: readonly string[],
  source: string,
): MergeResult {
  const exists = new Set(existing);
  const files: Record<string, number> = {};
  let updated = 0;
  let kept = 0;
  let added = 0;
  const dropped: string[] = [];
  for (const [f, ms] of Object.entries(old?.files ?? {})) {
    if (!exists.has(f)) dropped.push(f);
    else if (!measured.has(f)) {
      files[f] = ms;
      kept++;
    }
  }
  for (const [f, ms] of measured) {
    if (!exists.has(f)) continue;
    if (old?.files[f] === undefined) added++;
    else updated++;
    files[f] = ms;
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { timings: { source, files: sorted }, updated, kept, dropped: dropped.sort(), added };
}
