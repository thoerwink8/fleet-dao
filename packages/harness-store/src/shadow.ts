// 影子比对（#3776，讨论稿第五节 3「比对」）：冻结批次清单、存影子补丁、旧 PR 合并后拿合并 diff 给影子补丁评分。
// 两边的 diff 先规范化（按文件、去掉空白和格式化差异）再比；旧的结果永远是权威，这里只记差多少。
import { and, asc, eq, gt } from 'drizzle-orm';
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
