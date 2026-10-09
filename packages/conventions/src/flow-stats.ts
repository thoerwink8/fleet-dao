// 量流程快不快（design 第五节「流程只为快」要的两个数，加上被取消或重跑的 CI 轮数）。纯计算；读 GitHub 的翻页也在这里，
// 入口 bin/flow-stats.ts 只用本机的 gh。读不到、字段缺、合并列表或 CI 轮次列表是空的，一律抛「没查成」，不当 0。
//
// 开到合 = merged_at − created_at，单位分钟。中位：奇数取中间，偶数取中间两个的平均（和 ci-stats 同一条）。
// 90 分位用最近秩：升序后下标 ceil(0.9×n)−1（n=10 取第 9 个）。引擎 PR 只认 flow-branch 那条分支名。
// 被取消或重跑：这一轮 conclusion 是 cancelled，或 run_attempt > 1（GitHub 对同一次运行重跑，次数从 1 起）。两样都占只计 1。
// 失败但没取消、也没重跑的不计。每天按 merged_at 的 UTC 日；窗口里某天是 0 是量出来的，整份列表是空的才不打这份数。
import { isFlowBranch } from './flow-branch.ts';

export interface TierStats {
  count: number;
  medianMin: number;
  p90Min: number;
}

export interface DayCount {
  day: string;
  count: number;
}

export interface FlowStats {
  days: number;
  startIso: string;
  endIso: string;
  daily: DayCount[];
  /** 这一档一个都没有就是 null，不给中位 0。 */
  engine: TierStats | null;
  other: TierStats | null;
  wastedCi: number;
}

export interface LoadOptions {
  repo: string;
  now: Date;
  days: number;
  pageSize?: number;
  maxPages?: number;
}

function bad(why: string): never {
  throw new Error(`没查成：${why}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function timeOf(v: unknown, what: string): number {
  if (typeof v !== 'string' || v === '') bad(`${what} 不是时间（${String(v)}）`);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) bad(`${what} 不是时间（${v}）`);
  return t;
}

/** 缺省 7。不是 1 到 90 的整数就抛「没查成」（入口据此退出 2，不去读 GitHub）。 */
export function parseDays(text: string | undefined): number {
  if (text === undefined) return 7;
  if (!/^\d{1,2}$/.test(text)) bad('--days 要 1 到 90 的整数');
  const n = Number(text);
  if (n < 1 || n > 90) bad('--days 要 1 到 90 的整数');
  return n;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 窗口盖住的每个 UTC 日，含起点、终点那天。跨度异常直接失败，不靠循环自己停。 */
function eachUtcDay(startMs: number, endMs: number): string[] {
  const out: string[] = [];
  let cursor = Date.parse(`${utcDay(startMs)}T00:00:00.000Z`);
  const last = utcDay(endMs);
  for (let i = 0; i < 100; i++) {
    const day = utcDay(cursor);
    out.push(day);
    if (day === last) return out;
    cursor += 86_400_000;
  }
  return bad('窗口跨度不对');
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) bad('中位没有样本');
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    const v = sorted[mid];
    if (v === undefined) bad('中位没有样本');
    return v;
  }
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (a === undefined || b === undefined) bad('中位没有样本');
  return (a + b) / 2;
}

/** 最近秩。样本为空的档不要来叫它。 */
function p90(sorted: readonly number[]): number {
  const v = sorted[Math.ceil(0.9 * sorted.length) - 1];
  if (v === undefined) bad('90 分位没有样本');
  return v;
}

function tierOf(mins: readonly number[]): TierStats | null {
  if (mins.length === 0) return null;
  const sorted = [...mins].sort((a, b) => a - b);
  return { count: mins.length, medianMin: median(sorted), p90Min: p90(sorted) };
}

interface ParsedPull {
  number: number;
  createdMs: number;
  mergedMs: number | null;
  ref: string;
}

function parsePull(raw: unknown): ParsedPull {
  if (!isRecord(raw)) bad('PR 列表有一条不是对象');
  if (typeof raw.number !== 'number' || !Number.isInteger(raw.number) || raw.number < 1) {
    bad('PR 列表里有一条没有编号');
  }
  const n = raw.number;
  if (raw.created_at === undefined) bad(`PR ${n} 缺 created_at`);
  const createdMs = timeOf(raw.created_at, `PR ${n} 的 created_at`);
  if (raw.merged_at === undefined) bad(`PR ${n} 缺 merged_at`);
  const mergedMs = raw.merged_at === null ? null : timeOf(raw.merged_at, `PR ${n} 的 merged_at`);
  if (!isRecord(raw.head) || typeof raw.head.ref !== 'string' || raw.head.ref === '') bad(`PR ${n} 缺分支名`);
  if (mergedMs !== null && createdMs > mergedMs) bad(`PR ${n} 开到合的时间是负的`);
  return { number: n, createdMs, mergedMs, ref: raw.head.ref };
}

interface ParsedRun {
  id: number;
  createdMs: number;
  attempt: number;
  conclusion: string | null;
}

function parseRun(raw: unknown): ParsedRun {
  if (!isRecord(raw)) bad('CI 轮次有一条不是对象');
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id)) bad('CI 轮次缺 id');
  const id = raw.id;
  const createdMs = timeOf(raw.created_at, `CI 轮次 ${id} 的 created_at`);
  if (typeof raw.run_attempt !== 'number' || !Number.isInteger(raw.run_attempt) || raw.run_attempt < 1) {
    bad(`CI 轮次 ${id} 的 run_attempt 不是正整数（${String(raw.run_attempt)}）`);
  }
  if (typeof raw.status !== 'string' || raw.status === '') bad(`CI 轮次 ${id} 缺 status`);
  const conclusion = raw.conclusion;
  if (typeof conclusion === 'string' && conclusion !== '') {
    return { id, createdMs, attempt: raw.run_attempt, conclusion };
  }
  if (conclusion === null && raw.status !== 'completed') {
    return { id, createdMs, attempt: raw.run_attempt, conclusion: null };
  }
  if (raw.status === 'completed') bad(`CI 轮次 ${id} 已结束却没有 conclusion`);
  return bad(`CI 轮次 ${id} 的 conclusion 认不出`);
}

function compute(
  pullRaws: readonly unknown[],
  runRaws: readonly unknown[],
  startMs: number,
  endMs: number,
  days: number,
): FlowStats {
  const pulls = pullRaws.map(parsePull);
  const seenPull = new Set<number>();
  for (const p of pulls) {
    if (seenPull.has(p.number)) bad(`PR ${p.number} 出现了两次`);
    seenPull.add(p.number);
  }
  const runs = runRaws.map(parseRun);
  const seenRun = new Set<number>();
  for (const r of runs) {
    if (seenRun.has(r.id)) bad(`CI 轮次 ${r.id} 出现了两次`);
    seenRun.add(r.id);
  }

  const daysList = eachUtcDay(startMs, endMs);
  const counts = new Map(daysList.map((day) => [day, 0]));
  const engineMins: number[] = [];
  const otherMins: number[] = [];
  let merged = 0;
  for (const p of pulls) {
    if (p.mergedMs === null || p.mergedMs < startMs || p.mergedMs > endMs) continue;
    const day = utcDay(p.mergedMs);
    const prev = counts.get(day);
    if (prev === undefined) bad(`PR ${p.number} 的合并日 ${day} 不在窗口里`);
    counts.set(day, prev + 1);
    const mins = (p.mergedMs - p.createdMs) / 60_000;
    if (isFlowBranch(p.ref)) engineMins.push(mins);
    else otherMins.push(mins);
    merged += 1;
  }
  if (merged === 0) bad('窗口里没有合并的 PR');

  let wasted = 0;
  let inWindow = 0;
  for (const r of runs) {
    if (r.createdMs < startMs || r.createdMs > endMs) continue;
    inWindow += 1;
    if (r.conclusion === 'cancelled' || r.attempt > 1) wasted += 1;
  }
  if (inWindow === 0) bad('窗口里没有 ci.yml 轮次');

  return {
    days,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    daily: daysList.map((day) => {
      const count = counts.get(day);
      if (count === undefined) bad(`合并日 ${day} 没有计数`);
      return { day, count };
    }),
    engine: tierOf(engineMins),
    other: tierOf(otherMins),
    wastedCi: wasted,
  };
}

function pullsPath(repo: string, page: number, pageSize: number): string {
  const q = new URLSearchParams({
    state: 'closed',
    sort: 'updated',
    direction: 'desc',
    per_page: String(pageSize),
    page: String(page),
  });
  return `repos/${repo}/pulls?${q.toString()}`;
}

function runsPath(repo: string, page: number, pageSize: number, startMs: number): string {
  const day = utcDay(startMs);
  const q = new URLSearchParams({
    per_page: String(pageSize),
    page: String(page),
    created: `>=${day}`,
  });
  return `repos/${repo}/actions/workflows/ci.yml/runs?${q.toString()}`;
}

function pullLabel(raw: unknown): string {
  if (isRecord(raw) && typeof raw.number === 'number' && Number.isInteger(raw.number))
    return String(raw.number);
  return '（没有编号）';
}

/** 这一页里最旧的 updated_at。合并会把 updated_at 推到不早于 merged_at，所以比窗口早就可以停，不再翻后面的页。 */
function oldestUpdated(items: readonly unknown[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const raw of items) {
    if (!isRecord(raw)) bad('PR 列表有一条不是对象');
    const t = timeOf(raw.updated_at, `PR ${pullLabel(raw)} 的 updated_at`);
    if (t < min) min = t;
  }
  return min;
}

function collectPulls(
  gh: (path: string) => unknown,
  repo: string,
  startMs: number,
  pageSize: number,
  maxPages: number,
): unknown[] {
  const pulls: unknown[] = [];
  let done = false;
  for (let page = 1; page <= maxPages; page++) {
    const body = gh(pullsPath(repo, page, pageSize));
    if (!Array.isArray(body)) bad('PR 列表认不出（不是数组）');
    if (body.length === 0) {
      if (page === 1) bad('PR 列表是空的');
      done = true;
      break;
    }
    pulls.push(...body);
    // 页没满说明后面没有了；最旧一条已早于窗口，后面的页更旧，不可能再有窗口里的合并
    if (oldestUpdated(body) < startMs || body.length < pageSize) {
      done = true;
      break;
    }
  }
  if (!done) bad(`PR 没翻完（到了 ${maxPages} 页，窗口里的还可能在后面）`);
  return pulls;
}

function collectRuns(
  gh: (path: string) => unknown,
  repo: string,
  startMs: number,
  pageSize: number,
  maxPages: number,
): unknown[] {
  const runs: unknown[] = [];
  let total: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const body = gh(runsPath(repo, page, pageSize, startMs));
    if (!isRecord(body) || !Array.isArray(body.workflow_runs)) bad('CI 轮次列表认不出（没有 workflow_runs）');
    const tc = body.total_count;
    if (typeof tc !== 'number' || !Number.isInteger(tc) || tc < 0) bad('CI 轮次的 total_count 认不出');
    if (total === undefined) total = tc;
    else if (total !== tc) bad('CI 轮次的 total_count 变了');
    if (body.workflow_runs.length === 0) break;
    runs.push(...body.workflow_runs);
    if (runs.length >= total) break;
  }
  if (total === undefined) bad('CI 轮次列表认不出');
  if (total === 0) bad('CI 轮次列表是空的');
  if (runs.length !== total) bad(`CI 轮次没列全（要 ${total} 条，只拿到 ${runs.length} 条）`);
  return runs;
}

/** 用 gh 式的读取函数拉最近 days 天已合并的 PR 和 ci.yml 轮次，算出三样数。读不到、字段缺、列表为空都抛「没查成」。 */
export function flowStats(gh: (path: string) => unknown, opts: LoadOptions): FlowStats {
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) bad('--repo 要是 owner/名字');
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 90) bad('--days 要 1 到 90 的整数');
  if (!(opts.now instanceof Date) || !Number.isFinite(opts.now.getTime())) bad('现在的时间读不出');
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) bad('每页条数要 1 到 100');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) bad('翻页上限要 1 到 50');

  const endMs = opts.now.getTime();
  const startMs = endMs - opts.days * 86_400_000;
  const pulls = collectPulls(gh, opts.repo, startMs, pageSize, maxPages);
  const runs = collectRuns(gh, opts.repo, startMs, pageSize, maxPages);
  return compute(pulls, runs, startMs, endMs, opts.days);
}

function fmtMin(n: number): string {
  const tenths = Math.round(n * 10);
  if (!Number.isFinite(tenths)) bad('算出来的时长不是有限数');
  if (tenths % 10 === 0) return String(tenths / 10);
  return (tenths / 10).toFixed(1);
}

function tierLine(name: string, tier: TierStats | null): string {
  if (tier === null) return `${name}：这一档没有`;
  return `${name}（${tier.count} 个）中位 ${fmtMin(tier.medianMin)}，90 分位 ${fmtMin(tier.p90Min)}`;
}

/** 给人看的三行：每天合并、两档开到合、被取消或重跑的 CI 轮数。末尾有换行。 */
export function formatFlowStats(stats: FlowStats): string {
  const lines = [
    `最近 ${stats.days} 天（${stats.startIso} 到 ${stats.endIso}，UTC）`,
    '每天合并',
    ...stats.daily.map((d) => `${d.day}  ${d.count}`),
    '开到合（分钟）',
    tierLine('引擎 PR', stats.engine),
    tierLine('其他', stats.other),
    `被取消或重跑的 CI 轮数 ${stats.wastedCi}`,
  ];
  return `${lines.join('\n')}\n`;
}
