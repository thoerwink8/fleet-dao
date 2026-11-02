// 真执行的账（#3783，第 7 片，决定 0124）：冻结批次清单、记每次交回的补丁和该不该推、读这张单最近一次的产物。
// 影子批次（shadow.ts）和这里分开存：影子的产物任何自动流程都不消费，真执行的补丁恰恰是给 outbox 推的。
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { publishRuns, realBatchItems } from './schema.ts';
import { BatchFrozenError, type BatchItem } from './shadow.ts';
import { type Db, PAGE_MAX } from './store.ts';

/** 冻结一批真执行的单：整批一次写进去，这个批次号已经有行就拒（冻结后不改）。 */
export async function freezeRealBatch(db: Db, batchId: string, items: readonly BatchItem[]): Promise<void> {
  if (items.length === 0) throw new Error('空批次不冻结');
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ issue: realBatchItems.issue })
      .from(realBatchItems)
      .where(eq(realBatchItems.batchId, batchId))
      .limit(1);
    if (existing) throw new BatchFrozenError(batchId);
    await tx.insert(realBatchItems).values(items.map((i) => ({ batchId, ...i })));
  });
}

/** 一批的清单，按（仓、单号）往后翻页。 */
export async function listRealBatchItems(
  db: Db,
  batchId: string,
  after?: { repo: string; issue: number },
  limit = 50,
): Promise<BatchItem[]> {
  return db
    .select({
      repo: realBatchItems.repo,
      issue: realBatchItems.issue,
      baseSha: realBatchItems.baseSha,
      snapshotAt: realBatchItems.snapshotAt,
    })
    .from(realBatchItems)
    .where(
      and(
        eq(realBatchItems.batchId, batchId),
        after
          ? sql`(${realBatchItems.repo}, ${realBatchItems.issue}) > (${after.repo}, ${after.issue})`
          : undefined,
      ),
    )
    .orderBy(asc(realBatchItems.repo), asc(realBatchItems.issue))
    .limit(Math.min(limit, PAGE_MAX));
}

/** 这张单最近冻结进的真执行批次（切回找派工请求用）。 */
export async function latestRealBatchFor(
  db: Db,
  ref: { repo: string; issue: number },
): Promise<string | null> {
  const [row] = await db
    .select({ batchId: realBatchItems.batchId })
    .from(realBatchItems)
    .where(and(eq(realBatchItems.repo, ref.repo), eq(realBatchItems.issue, ref.issue)))
    .orderBy(desc(realBatchItems.snapshotAt), desc(realBatchItems.batchId))
    .limit(1);
  return row?.batchId ?? null;
}

/** 还有单没出过产物的真执行批次（内核每轮只看这些）。 */
export async function activeRealBatches(db: Db, limit = 20): Promise<string[]> {
  const rows = await db
    .selectDistinct({ batchId: realBatchItems.batchId })
    .from(realBatchItems)
    .where(
      sql`not exists (
        select 1 from fleet2.publish_runs r
        where r.batch_id = fleet2.real_batch_items.batch_id
          and r.repo = fleet2.real_batch_items.repo
          and r.issue = fleet2.real_batch_items.issue
      )`,
    )
    .orderBy(asc(realBatchItems.batchId))
    .limit(Math.min(limit, PAGE_MAX));
  return rows.map((r) => r.batchId);
}

export type PublishState = 'ready' | 'held' | 'empty' | 'released';
export type PublishRun = typeof publishRuns.$inferSelect;

export interface PublishRunInput {
  runId: string;
  batchId: string;
  repo: string;
  issue: number;
  baseSha: string;
  fencing: number;
  model: string;
  title: string;
  verdict: 'unverified' | 'passed' | 'failed' | 'unknown';
  patch: string;
  wallMs: number;
  branch: string;
  state: PublishState;
  reason?: string;
}

/** 记一次真执行的产物；同一个 runId 再记回原来那行（重放不出第二行）。单不在批次清单里拒。 */
export async function recordPublishRun(
  db: Db,
  run: PublishRunInput,
): Promise<{ created: boolean; run: PublishRun }> {
  const [item] = await db
    .select({ baseSha: realBatchItems.baseSha })
    .from(realBatchItems)
    .where(
      and(
        eq(realBatchItems.batchId, run.batchId),
        eq(realBatchItems.repo, run.repo),
        eq(realBatchItems.issue, run.issue),
      ),
    );
  if (!item) throw new Error(`${run.repo}#${run.issue} 不在真执行批次 ${run.batchId} 里`);
  if (item.baseSha !== run.baseSha) {
    throw new Error(
      `${run.repo}#${run.issue} 的基线和批次清单不一致：清单 ${item.baseSha}，产物 ${run.baseSha}`,
    );
  }
  const inserted = await db
    .insert(publishRuns)
    .values({ ...run, reason: run.reason ?? null })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { created: true, run: inserted[0] };
  const had = await getPublishRun(db, run.runId);
  if (!had) throw new Error(`发布记录 ${run.runId} 冲突却读不到原来那行`);
  return { created: false, run: had };
}

export async function getPublishRun(db: Db, runId: string): Promise<PublishRun | null> {
  const [row] = await db.select().from(publishRuns).where(eq(publishRuns.runId, runId));
  return row ?? null;
}

/** 这张单最近一次的产物（没有回 null）。 */
export async function latestPublishRun(
  db: Db,
  ref: { repo: string; issue: number },
): Promise<PublishRun | null> {
  const [row] = await db
    .select()
    .from(publishRuns)
    .where(and(eq(publishRuns.repo, ref.repo), eq(publishRuns.issue, ref.issue)))
    .orderBy(desc(publishRuns.id))
    .limit(1);
  return row ?? null;
}

/** 改产物的状态（切回时标 released）。 */
export async function setPublishState(
  db: Db,
  runId: string,
  state: PublishState,
  reason: string,
): Promise<void> {
  await db
    .update(publishRuns)
    .set({ state, reason, updatedAt: sql`now()` as unknown as Date })
    .where(eq(publishRuns.runId, runId));
}
