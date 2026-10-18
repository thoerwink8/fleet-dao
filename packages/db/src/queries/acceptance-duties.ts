import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { acceptanceDuties } from '../schema/index.ts';

export type AcceptanceDutyRow = typeof acceptanceDuties.$inferSelect;
export type AcceptanceDutyIdentity = Pick<
  AcceptanceDutyRow,
  'id' | 'generation' | 'repo' | 'issueNumber' | 'prNumber' | 'head'
>;

/** 只读持久账；失败照抛，不用评论或调用方状态代替。 */
export function readAcceptanceDutyRows(db: Db, identity: { repo: string; issueNumber: number }) {
  return db.query.acceptanceDuties.findMany({
    where: (t, { and, eq }) => and(eq(t.repo, identity.repo), eq(t.issueNumber, identity.issueNumber)),
    orderBy: (t, { asc }) => [asc(t.id)],
  });
}

/** 冲突更新在数据库中合并全部验收项；新项使旧的最终验收凭据失效。 */
export async function upsertAcceptanceDuty(db: Db, values: typeof acceptanceDuties.$inferInsert) {
  const added = sql`not (excluded.items <@ ${acceptanceDuties.items})`;
  await db
    .insert(acceptanceDuties)
    .values(values)
    .onConflictDoUpdate({
      target: [acceptanceDuties.taskId, acceptanceDuties.prNumber, acceptanceDuties.head],
      set: {
        items: sql`ARRAY(SELECT DISTINCT item FROM unnest(${acceptanceDuties.items} || excluded.items) AS item ORDER BY item)`,
        generation: sql`${acceptanceDuties.generation} + CASE WHEN ${added} THEN 1 ELSE 0 END`,
        mergeCommit: sql`coalesce(${acceptanceDuties.mergeCommit}, excluded.merge_commit)`,
        mergedAt: sql`coalesce(${acceptanceDuties.mergedAt}, excluded.merged_at)`,
        settledAt: sql`CASE WHEN ${added} THEN NULL ELSE ${acceptanceDuties.settledAt} END`,
        settledBy: sql`CASE WHEN ${added} THEN NULL ELSE ${acceptanceDuties.settledBy} END`,
        settleEvidence: sql`CASE WHEN ${added} THEN NULL ELSE ${acceptanceDuties.settleEvidence} END`,
      },
    });
}

/** 精确责任身份和代次 CAS，迟到的验收不能收掉后来新增的项。 */
export async function settleAcceptanceDuty(
  db: Db,
  input: AcceptanceDutyIdentity & { by: string; evidence: string },
  now: Date,
) {
  const by = input.by.trim(),
    evidence = input.evidence.trim();
  if (!by || !evidence) throw new Error('最终验收要写明谁验的、凭什么');
  const matches = and(
    eq(acceptanceDuties.id, input.id),
    eq(acceptanceDuties.generation, input.generation),
    eq(acceptanceDuties.repo, input.repo),
    eq(acceptanceDuties.issueNumber, input.issueNumber),
    eq(acceptanceDuties.prNumber, input.prNumber),
    eq(acceptanceDuties.head, input.head),
  );
  const rows = await db
    .update(acceptanceDuties)
    .set({ settledAt: now, settledBy: by, settleEvidence: evidence })
    .where(
      and(
        matches,
        isNull(acceptanceDuties.settledAt),
        sql`(${acceptanceDuties.prNumber} = 0 OR ${acceptanceDuties.mergeCommit} IS NOT NULL)`,
      ),
    )
    .returning();
  if (rows.length) return rows[0]!;
  const [same] = await db.select().from(acceptanceDuties).where(matches);
  if (same?.settledAt && same.settledBy === by && same.settleEvidence === evidence) return same;
  throw new Error('验收责任身份、代次或完成回执已变，请重新读取核验');
}
