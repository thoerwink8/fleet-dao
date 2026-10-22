// 验收责任账（#3037）只剩只读和一次性交回（#3630，决定 0113 第二片）：#3591 起引擎不再写新行，
// 结清、替代、归并的写口和管理 CLI 都删了。表和旧行保留只读（引擎收尾、本机租约、公开读口照旧读）；
// 还开着的旧行由 jobs/acceptance-handback-once.ts 一次性交回原单，只改 settled_* 三列，不删行。
import { acceptanceDutyState } from '@fleet-dao/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { acceptanceDuties } from '../schema/index.ts';

export type AcceptanceDutyRow = typeof acceptanceDuties.$inferSelect;

/** 只读持久账；失败照抛，不用评论或调用方状态代替。 */
export function readAcceptanceDutyRows(db: Db, identity: { repo: string; issueNumber: number }) {
  return db.query.acceptanceDuties.findMany({
    where: (t, { and, eq }) => and(eq(t.repo, identity.repo), eq(t.issueNumber, identity.issueNumber)),
    orderBy: (t, { asc }) => [asc(t.id)],
  });
}

/**
 * 全库还开着的验收责任（按 id 先后）：开不开照 shared 的 acceptanceDutyState，和引擎收尾、公开读口同一判法
 * （被已合已验的后续交付替代收口、替代没过期的不算开着）。替代要看同单的别的行，所以整表读回再按单判；表只进不删，量小（10-22 共 166 行）。
 * 读失败照抛，不回空数组冒充「没有开着的」。
 */
export async function listOpenAcceptanceDuties(db: Db): Promise<AcceptanceDutyRow[]> {
  const rows = await db.query.acceptanceDuties.findMany({ orderBy: (t, { asc }) => [asc(t.id)] });
  const byIssue = new Map<string, AcceptanceDutyRow[]>();
  for (const r of rows) {
    const key = `${r.repo.toLowerCase()}#${r.issueNumber}`;
    byIssue.set(key, [...(byIssue.get(key) ?? []), r]);
  }
  return rows.filter(
    (r) => acceptanceDutyState(r, byIssue.get(`${r.repo.toLowerCase()}#${r.issueNumber}`) ?? []) === 'open',
  );
}

/**
 * 把一行旧责任标成「已交回原单」（#3630）：写 settled_* 三列（谁交回的、交回到哪），不删行、不改别的列。
 * 只认现读的这一代、且还没结清的：已经结清（含上一次交回）回 'already'，不覆盖原来的结清记录；代次变了抛错。
 */
export async function handBackAcceptanceDuty(
  db: Db,
  input: { id: number; generation: number; by: string; evidence: string },
  now: Date,
): Promise<'handed_back' | 'already'> {
  const by = input.by.trim();
  const evidence = input.evidence.trim();
  if (!by || !evidence) throw new Error('交回要写明谁交回的、交回到哪');
  const updated = await db
    .update(acceptanceDuties)
    .set({ settledAt: now, settledBy: by, settleEvidence: evidence })
    .where(
      and(
        eq(acceptanceDuties.id, input.id),
        eq(acceptanceDuties.generation, input.generation),
        isNull(acceptanceDuties.settledAt),
      ),
    )
    .returning({ id: acceptanceDuties.id });
  if (updated.length > 0) return 'handed_back';
  const [row] = await db.select().from(acceptanceDuties).where(eq(acceptanceDuties.id, input.id));
  if (!row) throw new Error(`验收责任 ${input.id} 读不到`);
  if (row.settledAt != null) return 'already';
  throw new Error(`验收责任 ${input.id} 的代次已变（现在是第 ${row.generation} 代），请重新读取`);
}
