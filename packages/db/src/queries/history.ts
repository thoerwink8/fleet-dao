// fleet history：按关键词和改动位置翻做过的需求与结果。形状对齐 @fleet-dao/shared 的 HistoryResponse.items。
import { and, desc, eq, exists, ilike, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { specs, subtasks, tasks } from '../schema/index.ts';

export interface SpecHit {
  taskId: string;
  title: string;
  specDir?: string;
  resultSummary?: string;
  mergedAt?: string;
}

export interface SearchSpecsInput {
  /** 空格分开的多个词都要命中（每个词在标题、原话、需求目录、需求摘要、结果摘要、子任务改动位置里任一处出现即可）。 */
  query: string;
  /** 1–20，默认 5。 */
  limit?: number;
  repoId?: string;
}

/** LIKE 里 % _ \ 按字面匹配。 */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchSpecs(db: Db, input: SearchSpecsInput): Promise<SpecHit[]> {
  const terms = input.query.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];
  const limit = Math.min(20, Math.max(1, input.limit ?? 5));

  const termMatches = terms.map((term): SQL => {
    const p = likeContains(term);
    const touched = db
      .select({ one: sql`1` })
      .from(subtasks)
      .where(
        and(
          eq(subtasks.taskId, tasks.id),
          sql`exists (select 1 from unnest(${subtasks.touches}) as touched(path) where touched.path ilike ${p})`,
        ),
      );
    return or(
      ilike(tasks.title, p),
      ilike(tasks.rawRequest, p),
      ilike(tasks.specDir, p),
      ilike(specs.summary, p),
      ilike(specs.resultSummary, p),
      exists(touched),
    ) as SQL;
  });

  const rows = await db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      specDir: tasks.specDir,
      resultSummary: specs.resultSummary,
      mergedAt: specs.mergedAt,
    })
    .from(specs)
    .innerJoin(tasks, eq(tasks.id, specs.taskId))
    .where(and(input.repoId ? eq(tasks.repoId, input.repoId) : undefined, ...termMatches))
    .orderBy(sql`${specs.mergedAt} desc nulls last`, desc(tasks.createdAt))
    .limit(limit);

  return rows.map((r) => {
    const hit: SpecHit = { taskId: r.taskId, title: r.title };
    if (r.specDir !== null) hit.specDir = r.specDir;
    if (r.resultSummary !== null) hit.resultSummary = r.resultSummary;
    if (r.mergedAt !== null) hit.mergedAt = r.mergedAt.toISOString();
    return hit;
  });
}
