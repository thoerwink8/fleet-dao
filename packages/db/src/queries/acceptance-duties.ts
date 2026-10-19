import {
  type AcceptanceCoverage,
  normalizeAcceptanceCoverage,
  parseAcceptanceCoverage,
  sameAcceptanceCoverage,
  supersessionProblem,
} from '@fleet-dao/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  acceptanceDuties,
  acceptanceDutySupersessions,
  pullRequests,
  repos,
  runs,
  tasks,
} from '../schema/index.ts';

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

/**
 * 历史责任归并预检（#3207 第 1 片）要的全部事实，纯读：任务及其仓、原 workflow / run 对应的运行、同仓 PR 镜像、
 * 点名的责任行、最终头上已有的责任行。回执只取 PR 镜像（pull_requests），不看责任行自己的 merge 列。
 * 任一次读失败照抛；点名的责任号读不全由调用方判。
 */
export async function readAcceptanceMergeFacts(
  db: Db,
  q: {
    taskId: string;
    workflowId: string;
    temporalRunId: string;
    prNumber: number;
    head: string;
    dutyIds: readonly number[];
  },
) {
  const [task] = await db
    .select({
      id: tasks.id,
      issueNumber: tasks.issueNumber,
      repoId: tasks.repoId,
      owner: repos.owner,
      name: repos.name,
    })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(eq(tasks.id, q.taskId));
  const matchedRuns = await db
    .select({ id: runs.id, taskId: runs.taskId })
    .from(runs)
    .where(and(eq(runs.workflowId, q.workflowId), eq(runs.temporalRunId, q.temporalRunId)));
  const [pr] = task
    ? await db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, task.repoId), eq(pullRequests.number, q.prNumber)))
    : [];
  const duties = await db
    .select()
    .from(acceptanceDuties)
    .where(inArray(acceptanceDuties.id, [...q.dutyIds]))
    .orderBy(asc(acceptanceDuties.id));
  const [target] = await db
    .select()
    .from(acceptanceDuties)
    .where(
      and(
        eq(acceptanceDuties.taskId, q.taskId),
        eq(acceptanceDuties.prNumber, q.prNumber),
        eq(acceptanceDuties.head, q.head),
      ),
    );
  return { task, runs: matchedRuns, pr, duties, target };
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
        // 源行新增项：原替代没核过新项，一并作废（历史留在 acceptance_duty_supersessions）
        supersededAt: sql`CASE WHEN ${added} THEN NULL ELSE ${acceptanceDuties.supersededAt} END`,
        supersededBy: sql`CASE WHEN ${added} THEN NULL ELSE ${acceptanceDuties.supersededBy} END`,
        supersedeEvidence: sql`CASE WHEN ${added} THEN NULL ELSE ${acceptanceDuties.supersedeEvidence} END`,
        successorId: sql`CASE WHEN ${added} THEN NULL ELSE ${acceptanceDuties.successorId} END`,
        successorGeneration: sql`CASE WHEN ${added} THEN NULL ELSE ${acceptanceDuties.successorGeneration} END`,
        supersedeCoverage: sql`CASE WHEN ${added} THEN NULL ELSE ${acceptanceDuties.supersedeCoverage} END`,
      },
    });
}

const sameIdentity = (row: AcceptanceDutyRow, id: AcceptanceDutyIdentity) =>
  row.id === id.id &&
  row.generation === id.generation &&
  row.repo === id.repo &&
  row.issueNumber === id.issueNumber &&
  row.prNumber === id.prNumber &&
  row.head === id.head;

/**
 * 旧头替代收口（#3114）：PR 换头后旧头永远没有合并回执，操作者显式把它指向同单同 PR 已合已验的最终责任。
 * 源、目标两行按 id 顺序 FOR UPDATE 锁住，现读精确身份和代次、核验覆盖、写源行、追加操作记录都在一个事务里；
 * 旧行合并回执不填。同一请求重放幂等；已有现行替代时换目标、换证据或换覆盖声明报错，不冒充成功；替代因目标换代过期的可以重新指。
 * 源项和目标项措辞不同的（不同冷验收轮次写的），操作者用 coverage 逐源项声明由目标哪一条覆盖、依据是什么；
 * 声明随替代写在源行和操作记录里，读时关闭判定用同一份（shared 的 supersessionProblem），没声明的源项只认整串相等。
 */
export async function supersedeAcceptanceDuty(
  db: Db,
  input: {
    source: AcceptanceDutyIdentity;
    target: AcceptanceDutyIdentity;
    by: string;
    evidence: string;
    coverage?: readonly AcceptanceCoverage[];
  },
  now: Date,
) {
  const by = input.by.trim(),
    evidence = input.evidence.trim();
  if (!by || !evidence) throw new Error('替代收口要写明谁做的、凭什么');
  const parsed = parseAcceptanceCoverage(input.coverage ?? []);
  if (!parsed) throw new Error('覆盖声明要写明每条源项、目标项原文和依据');
  const coverage = normalizeAcceptanceCoverage(parsed);
  const { source, target } = input;
  if (source.id === target.id) throw new Error('替代收口的源和目标是同一行');
  return db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(acceptanceDuties)
      .where(inArray(acceptanceDuties.id, [source.id, target.id]))
      .orderBy(asc(acceptanceDuties.id))
      .for('update');
    const src = locked.find((r) => r.id === source.id);
    const tgt = locked.find((r) => r.id === target.id);
    if (!src || !sameIdentity(src, source)) throw new Error('源验收责任身份或代次已变，请重新读取核验');
    if (!tgt || !sameIdentity(tgt, target)) throw new Error('目标验收责任身份或代次已变，请重新读取核验');
    if (src.taskId !== tgt.taskId) throw new Error('替代收口不能跨任务');
    if (src.supersededAt && src.successorId !== null) {
      const prior =
        src.successorId === tgt.id
          ? tgt
          : (
              await tx
                .select()
                .from(acceptanceDuties)
                .where(eq(acceptanceDuties.id, src.successorId))
                .for('update')
            )[0];
      if (!supersessionProblem(src, prior, src.successorGeneration)) {
        if (
          src.successorId === tgt.id &&
          src.successorGeneration === tgt.generation &&
          src.supersededBy === by &&
          src.supersedeEvidence === evidence &&
          sameAcceptanceCoverage(src.supersedeCoverage, coverage)
        )
          return src;
        throw new Error('源验收责任已有现行替代（目标、证据或覆盖声明不同），不冒充本次成功');
      }
      // 原替代已过期（目标换代、未再验）：可以按现读重新指，旧的那次留在操作记录里
    }
    const problem = supersessionProblem(src, tgt, tgt.generation, coverage);
    if (problem) throw new Error(`不能替代收口：${problem}`);
    const [row] = await tx
      .update(acceptanceDuties)
      .set({
        supersededAt: now,
        supersededBy: by,
        supersedeEvidence: evidence,
        successorId: tgt.id,
        successorGeneration: tgt.generation,
        supersedeCoverage: coverage,
      })
      .where(and(eq(acceptanceDuties.id, src.id), eq(acceptanceDuties.generation, src.generation)))
      .returning();
    if (!row) throw new Error('源验收责任身份或代次已变，请重新读取核验');
    await tx.insert(acceptanceDutySupersessions).values({
      sourceId: src.id,
      sourceGeneration: src.generation,
      sourceHead: src.head,
      targetId: tgt.id,
      targetGeneration: tgt.generation,
      targetHead: tgt.head,
      targetMergeCommit: tgt.mergeCommit ?? '',
      repo: src.repo,
      issueNumber: src.issueNumber,
      prNumber: src.prNumber,
      by,
      evidence,
      coverage,
      createdAt: now,
    });
    return row;
  });
}

/** 某单替代收口的全部操作记录（按先后）。 */
export function readAcceptanceDutySupersessions(db: Db, identity: { repo: string; issueNumber: number }) {
  return db.query.acceptanceDutySupersessions.findMany({
    where: (t, { and, eq }) => and(eq(t.repo, identity.repo), eq(t.issueNumber, identity.issueNumber)),
    orderBy: (t, { asc }) => [asc(t.id)],
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
        isNull(acceptanceDuties.supersededAt),
        sql`(${acceptanceDuties.prNumber} = 0 OR ${acceptanceDuties.mergeCommit} IS NOT NULL)`,
      ),
    )
    .returning();
  const settled = rows[0];
  if (settled) return settled;
  const [same] = await db.select().from(acceptanceDuties).where(matches);
  if (same?.settledAt && same.settledBy === by && same.settleEvidence === evidence) return same;
  throw new Error('验收责任身份、代次或完成回执已变，请重新读取核验');
}
