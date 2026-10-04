// 量一个工作流最近几轮跑得怎么样（CI 提速每一步改前改后都用它量，docs/ci-speedup-plan.md「怎么量」）：
// 墙钟 = 整轮从开跑到结束；排队 = 创建到第一个 job 开跑；机器分钟 = 各 job 实际跑的秒数之和（GitHub 免费档并发上限 20，
// 机器分钟和 job 数才是「占了多少槽」）；被跳过的 job 不算。纯计算，不碰网络；入口在 bin/ci-stats.ts。
// 读不出的时间（缺字段、不是时间）抛错，不当 0 秒：当 0 就会把「没量到」冒充成「很快」。

export interface RunInput {
  id: number;
  event: string;
  head_sha: string;
  conclusion: string | null;
  created_at: string;
  /** 必给：缺了或为 null 时 rowOf 报错，不退回 created_at（会把排队时间算进墙钟）。 */
  run_started_at: string | null;
  updated_at: string;
}

export interface JobInput {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface RunRow {
  id: number;
  event: string;
  sha: string;
  conclusion: string;
  wallSec: number;
  queueSec: number;
  machineSec: number;
  /** 真跑了的 job 数（不含 skipped）。 */
  jobs: number;
  /** 各 job 的秒数。 */
  perJob: Record<string, number>;
}

function ms(v: string | null | undefined, what: string): number {
  const t = v ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(t)) throw new Error(`${what} 不是时间（${String(v)}）`);
  return t;
}

/** 一轮的数字。没跑完的运行（conclusion 为空）、没有任何 job 开跑都抛：调用方只传已完成的。 */
export function rowOf(run: RunInput, jobs: readonly JobInput[]): RunRow {
  if (run.conclusion === null) throw new Error(`运行 ${run.id} 还没跑完`);
  const ran = jobs.filter((j) => j.conclusion !== 'skipped');
  if (ran.length === 0) throw new Error(`运行 ${run.id} 一个 job 都没跑（读不到 job 列表？）`);
  const perJob: Record<string, number> = {};
  let machine = 0;
  let firstStart = Number.POSITIVE_INFINITY;
  for (const j of ran) {
    const start = ms(j.started_at, `运行 ${run.id} 的 job「${j.name}」started_at`);
    const secs = (ms(j.completed_at, `运行 ${run.id} 的 job「${j.name}」completed_at`) - start) / 1000;
    perJob[j.name] = secs;
    machine += secs;
    firstStart = Math.min(firstStart, start);
  }
  return {
    id: run.id,
    event: run.event,
    sha: run.head_sha.slice(0, 8),
    conclusion: run.conclusion,
    wallSec:
      (ms(run.updated_at, `运行 ${run.id} updated_at`) -
        ms(run.run_started_at, `运行 ${run.id} run_started_at`)) /
      1000,
    queueSec: (firstStart - ms(run.created_at, `运行 ${run.id} created_at`)) / 1000,
    machineSec: machine,
    jobs: ran.length,
    perJob,
  };
}

/** --since 的值转成毫秒；空串 = 不限；不是时间抛错（不静默当成不限）。 */
export function parseSince(text: string): number | undefined {
  if (text === '') return undefined;
  const t = Date.parse(text);
  if (!Number.isFinite(t)) throw new Error(`--since 不是时间（${text}）`);
  return t;
}

/** 这一轮是不是在 --since 之前创建的：按时刻比，不按字符串比（带时区的 ISO 时间字典序会错判）；读不出创建时间抛错。 */
export function createdBefore(createdAt: string, sinceMs: number): boolean {
  return ms(createdAt, 'created_at') < sinceMs;
}

const median = (a: readonly number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  // 偶数个取中间两个的平均（不是偏上的那个）；summarize 只对非空的一组调它
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

export interface Summary {
  event: string;
  runs: number;
  wallMedian: number;
  wallMax: number;
  queueMedian: number;
  jobsMedian: number;
  machineMinMedian: number;
  machineMinTotal: number;
}

/** 按事件（push / pull_request）各汇总一行；一轮都没有的事件不出行（不编数字）。 */
export function summarize(rows: readonly RunRow[]): Summary[] {
  const out: Summary[] = [];
  for (const event of [...new Set(rows.map((r) => r.event))].sort()) {
    const g = rows.filter((r) => r.event === event);
    out.push({
      event,
      runs: g.length,
      wallMedian: median(g.map((r) => r.wallSec)),
      wallMax: Math.max(...g.map((r) => r.wallSec)),
      queueMedian: median(g.map((r) => r.queueSec)),
      jobsMedian: median(g.map((r) => r.jobs)),
      machineMinMedian: median(g.map((r) => r.machineSec)) / 60,
      machineMinTotal: g.reduce((s, r) => s + r.machineSec, 0) / 60,
    });
  }
  return out;
}
