// 影子比对（#3776，讨论稿第五节 3「比对」）：冻结批次清单、存影子补丁、旧 PR 合并后拿合并 diff 给影子补丁评分。
// 两边的 diff 先规范化（按文件、去掉空白和格式化差异）再比；旧的结果永远是权威，这里只记差多少。
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { shadowBatchItems, shadowCompare, shadowRuns } from './schema.ts';
import { type Db, PAGE_MAX } from './store.ts';

/** 改动按文件分：每个文件一组「+行」「-行」，行里的空白全去掉，空行不算。 */
export type NormalizedDiff = Map<string, Set<string>>;

export function normalizeDiff(diff: string): NormalizedDiff {
  const out: NormalizedDiff = new Map();
  let file: string | undefined;
  let from: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = undefined;
      from = undefined;
      continue;
    }
    if (line.startsWith('--- ')) {
      from = pathOf(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      // 删掉的文件 +++ 是 /dev/null，按原来的路径记
      file = pathOf(line.slice(4)) ?? from;
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    if (!file || !(line.startsWith('+') || line.startsWith('-'))) continue;
    const body = line.slice(1).replace(/\s+/g, '');
    if (body) out.get(file)?.add(`${line[0]}${body}`);
  }
  return out;
}

function pathOf(raw: string): string | undefined {
  const p = raw.trim().replace(/\t.*$/, '');
  if (p === '/dev/null') return undefined;
  return p.replace(/^[ab]\//, '');
}

export interface DiffScore {
  shadowFiles: number;
  refFiles: number;
  sharedFiles: number;
  /** 改了哪些文件的重合（交集 / 并集）。两边都没改算 1。 */
  fileJaccard: number;
  /** 改动行（规范化后、带文件名）的重合。 */
  lineJaccard: number;
  /** 影子多改的文件（参照里没有），最多列 50 个。 */
  shadowOnly: string[];
  /** 影子漏改的文件（参照里有、影子没有），最多列 50 个。 */
  refOnly: string[];
  /** 规范化后完全一样。 */
  identical: boolean;
}

const LIST_MAX = 50;

export function compareDiffs(shadow: string, ref: string): DiffScore {
  const a = normalizeDiff(shadow);
  const b = normalizeDiff(ref);
  const shared = [...a.keys()].filter((f) => b.has(f));
  const lines = (d: NormalizedDiff) => new Set([...d].flatMap(([f, s]) => [...s].map((l) => `${f}\0${l}`)));
  const la = lines(a);
  const lb = lines(b);
  const fileJaccard = jaccard(new Set(a.keys()), new Set(b.keys()));
  const lineJaccard = jaccard(la, lb);
  return {
    shadowFiles: a.size,
    refFiles: b.size,
    sharedFiles: shared.length,
    fileJaccard,
    lineJaccard,
    shadowOnly: [...a.keys()]
      .filter((f) => !b.has(f))
      .sort()
      .slice(0, LIST_MAX),
    refOnly: [...b.keys()]
      .filter((f) => !a.has(f))
      .sort()
      .slice(0, LIST_MAX),
    identical: fileJaccard === 1 && lineJaccard === 1,
  };
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return Math.round((inter / (a.size + b.size - inter)) * 1000) / 1000;
}

export interface BatchItem {
  repo: string;
  issue: number;
  baseSha: string;
  snapshotAt: Date;
}

export class BatchFrozenError extends Error {
  constructor(batchId: string) {
    super(`批次 ${batchId} 已经冻结过，不改；要换单另起一批`);
    this.name = 'BatchFrozenError';
  }
}

/** 冻结一批：整批一次写进去，这个批次号已经有行就拒（冻结后不改）。 */
export async function freezeBatch(db: Db, batchId: string, items: readonly BatchItem[]): Promise<void> {
  if (items.length === 0) throw new Error('空批次不冻结');
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ issue: shadowBatchItems.issue })
      .from(shadowBatchItems)
      .where(eq(shadowBatchItems.batchId, batchId))
      .limit(1);
    if (existing) throw new BatchFrozenError(batchId);
    await tx.insert(shadowBatchItems).values(items.map((i) => ({ batchId, ...i })));
  });
}

/** 一批的清单，按（仓、单号）往后翻页。 */
export async function listBatchItems(
  db: Db,
  batchId: string,
  after?: { repo: string; issue: number },
  limit = 50,
): Promise<BatchItem[]> {
  return db
    .select({
      repo: shadowBatchItems.repo,
      issue: shadowBatchItems.issue,
      baseSha: shadowBatchItems.baseSha,
      snapshotAt: shadowBatchItems.snapshotAt,
    })
    .from(shadowBatchItems)
    .where(
      and(
        eq(shadowBatchItems.batchId, batchId),
        after
          ? sql`(${shadowBatchItems.repo}, ${shadowBatchItems.issue}) > (${after.repo}, ${after.issue})`
          : undefined,
      ),
    )
    .orderBy(asc(shadowBatchItems.repo), asc(shadowBatchItems.issue))
    .limit(Math.min(limit, PAGE_MAX));
}

export interface ShadowRunInput {
  runId: string;
  batchId: string;
  repo: string;
  issue: number;
  baseSha: string;
  verdict: 'unverified' | 'passed' | 'failed' | 'unknown';
  patch: string;
  wallMs: number;
  tokens?: number;
}

/** 记一次影子产物；同一个 runId 再记回原来那行的号（重放不出第二行）。单不在批次清单里拒。 */
export async function recordShadowRun(db: Db, run: ShadowRunInput): Promise<number> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ baseSha: shadowBatchItems.baseSha })
      .from(shadowBatchItems)
      .where(
        and(
          eq(shadowBatchItems.batchId, run.batchId),
          eq(shadowBatchItems.repo, run.repo),
          eq(shadowBatchItems.issue, run.issue),
        ),
      );
    if (!item) throw new Error(`${run.repo}#${run.issue} 不在批次 ${run.batchId} 里`);
    if (item.baseSha !== run.baseSha)
      throw new Error(`${run.repo}#${run.issue} 的基线 ${run.baseSha} 和批次清单里的 ${item.baseSha} 不一样`);
    const [inserted] = await tx
      .insert(shadowRuns)
      .values({ ...run, tokens: run.tokens ?? null })
      .onConflictDoNothing({ target: shadowRuns.runId })
      .returning({ id: shadowRuns.id });
    if (inserted) return inserted.id;
    const [prior] = await tx
      .select({ id: shadowRuns.id })
      .from(shadowRuns)
      .where(eq(shadowRuns.runId, run.runId));
    if (!prior) throw new Error(`影子产物 ${run.runId} 既没写进去也读不到`);
    return prior.id;
  });
}

/** 旧 PR 合并后评分：读影子补丁、和合并 diff 比，写一行；同一个影子产物评过就回原来的分（不重算、不覆盖）。 */
export async function recordCompare(
  db: Db,
  input: { shadowRunId: number; mergedPr: number; mergedSha: string; mergedDiff: string },
): Promise<DiffScore> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ patch: shadowRuns.patch, batchId: shadowRuns.batchId })
      .from(shadowRuns)
      .where(eq(shadowRuns.id, input.shadowRunId));
    if (!run) throw new Error(`没有影子产物 ${input.shadowRunId}`);
    const [prior] = await tx
      .select({ score: shadowCompare.score })
      .from(shadowCompare)
      .where(eq(shadowCompare.shadowRunId, input.shadowRunId));
    if (prior) return prior.score as DiffScore;
    const score = compareDiffs(run.patch, input.mergedDiff);
    await tx.insert(shadowCompare).values({
      shadowRunId: input.shadowRunId,
      batchId: run.batchId,
      mergedPr: input.mergedPr,
      mergedSha: input.mergedSha,
      score,
    });
    return score;
  });
}

/** 影子静默的报警线：批次里还有单没跑出产物、最近一条产物（没有就按冻结时刻）早于这么久，就报。 */
export const SHADOW_SILENCE_MS = 24 * 60 * 60 * 1000;

export type ShadowSilence =
  | { kind: 'idle' }
  | { kind: 'ok'; pending: number; lastAt: Date }
  | { kind: 'silent'; pending: number; lastAt: Date; silentMs: number };

/**
 * 防「影子静默不跑」：一批里还有没产物的单，最近一条产物（或冻结时刻）离数据库 now() 超过报警线就是 silent。
 * 只读这一批的清单行和产物里最大的时刻，读的行数和批次大小成正比，不和产物表大小成正比。
 */
export async function shadowSilence(
  db: Db,
  batchId: string,
  thresholdMs = SHADOW_SILENCE_MS,
): Promise<ShadowSilence> {
  const [items] = await db
    .select({
      // 单表查询里 drizzle 的列不带表名，子查询里同名列会认到内层表：这里写全名
      pending: sql<number>`(count(*) filter (where not exists (
        select 1 from fleet2.shadow_runs r
        where r.batch_id = fleet2.shadow_batch_items.batch_id
          and r.repo = fleet2.shadow_batch_items.repo
          and r.issue = fleet2.shadow_batch_items.issue
      )))::int`,
      frozenAt: sql<string | null>`max(${shadowBatchItems.snapshotAt})::text`,
    })
    .from(shadowBatchItems)
    .where(eq(shadowBatchItems.batchId, batchId));
  if (!items?.frozenAt || items.pending === 0) return { kind: 'idle' };
  const [runs] = await db
    .select({
      lastRunAt: sql<string | null>`max(${shadowRuns.createdAt})::text`,
      now: sql<string>`now()::text`,
    })
    .from(shadowRuns)
    .where(eq(shadowRuns.batchId, batchId));
  const frozenAt = new Date(items.frozenAt);
  const lastRunAt = runs?.lastRunAt ? new Date(runs.lastRunAt) : undefined;
  const lastAt = lastRunAt && lastRunAt > frozenAt ? lastRunAt : frozenAt;
  if (!runs?.now) throw new Error('读不到数据库时刻');
  const silentMs = new Date(runs.now).getTime() - lastAt.getTime();
  return silentMs > thresholdMs
    ? { kind: 'silent', pending: items.pending, lastAt, silentMs }
    : { kind: 'ok', pending: items.pending, lastAt };
}

/** 读旧 PR 的合并结果（只读 GitHub，由部署传进来）：没合并回 undefined，读不成抛。 */
export type MergedReader = (
  repo: string,
  issue: number,
) => Promise<{ pr: number; sha: string; diff: string } | undefined>;

export interface CompareSweep {
  scored: number;
  /** 旧 PR 还没合并的，下一轮再看。 */
  waiting: number;
  /** 读合并结果失败的，原因各记一条，下一轮再试。 */
  failed: { shadowRunId: number; error: string }[];
  /** 下一轮从这里往后读；读到头回 0。 */
  nextAfter: number;
}

/**
 * 给一批里还没评分的影子产物评分：按产物号往后读一页，每条问一次旧 PR 合没合，合了就评。
 * 一页一轮，读的行数和页大小成正比；没合并、读失败的留着下一轮再看，不当成评过。
 */
export async function sweepCompare(
  db: Db,
  batchId: string,
  readMerged: MergedReader,
  opts: { afterRunId?: number; limit?: number } = {},
): Promise<CompareSweep> {
  const limit = Math.min(opts.limit ?? 20, PAGE_MAX);
  const page = await db
    .select({ id: shadowRuns.id, repo: shadowRuns.repo, issue: shadowRuns.issue })
    .from(shadowRuns)
    .leftJoin(shadowCompare, eq(shadowCompare.shadowRunId, shadowRuns.id))
    .where(
      and(
        eq(shadowRuns.batchId, batchId),
        gt(shadowRuns.id, opts.afterRunId ?? 0),
        sql`${shadowCompare.shadowRunId} is null`,
      ),
    )
    .orderBy(asc(shadowRuns.id))
    .limit(limit);
  const out: CompareSweep = { scored: 0, waiting: 0, failed: [], nextAfter: 0 };
  for (const r of page) {
    let merged: Awaited<ReturnType<MergedReader>>;
    try {
      merged = await readMerged(r.repo, r.issue);
    } catch (err) {
      out.failed.push({ shadowRunId: r.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!merged) {
      out.waiting++;
      continue;
    }
    await recordCompare(db, {
      shadowRunId: r.id,
      mergedPr: merged.pr,
      mergedSha: merged.sha,
      mergedDiff: merged.diff,
    });
    out.scored++;
  }
  out.nextAfter = page.length === limit ? (page.at(-1)?.id ?? 0) : 0;
  return out;
}

export interface CompareRow {
  shadowRunId: number;
  repo: string;
  issue: number;
  verdict: string;
  wallMs: number;
  mergedPr: number;
  score: DiffScore;
}

/** 一批的比对表，按影子产物号往后翻页；读的行数和页大小成正比。 */
export async function listCompare(
  db: Db,
  batchId: string,
  afterRunId = 0,
  limit = 50,
): Promise<CompareRow[]> {
  const rows = await db
    .select({
      shadowRunId: shadowCompare.shadowRunId,
      repo: shadowRuns.repo,
      issue: shadowRuns.issue,
      verdict: shadowRuns.verdict,
      wallMs: shadowRuns.wallMs,
      mergedPr: shadowCompare.mergedPr,
      score: shadowCompare.score,
    })
    .from(shadowCompare)
    .innerJoin(shadowRuns, eq(shadowRuns.id, shadowCompare.shadowRunId))
    .where(and(eq(shadowCompare.batchId, batchId), gt(shadowCompare.shadowRunId, afterRunId)))
    .orderBy(asc(shadowCompare.shadowRunId))
    .limit(Math.min(limit, PAGE_MAX));
  return rows.map((r) => ({ ...r, score: r.score as DiffScore }));
}
