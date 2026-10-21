// 派生候选账的有界维护；纯读入口在 commander.ts，两个引擎消费者必须先调这里。
import { acceptanceDutyState } from '@fleet-dao/shared';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  acceptanceDuties,
  acceptanceCandidateBootstrap as bootstrap,
  acceptanceCandidateGroups as groups,
} from '../schema/index.ts';

// shared 判法改变时须递增并用正式迁移重建；摘要测试守住不知情的缓存复用。
export const ACCEPTANCE_CANDIDATE_SEMANTICS_VERSION = 1;
export const acceptanceCandidatesUnknown = (why: string) => new Error(`验收候选未读全（unknown）：${why}`);

/** 导出正式 builder 供执行计划回归；部分索引与这个公平顺序一致。 */
export function acceptanceDirtyGroupsQuery(db: Db, limit: number) {
  return db
    .select()
    .from(groups)
    .where(sql`${groups.dirty}`)
    .orderBy(sql`${groups.lastAttemptAt} asc nulls first`, asc(groups.taskId), asc(groups.prNumber))
    .limit(limit);
}

export async function assertAcceptanceCandidatesReady(db: Db) {
  const [state] = await db.select().from(bootstrap).where(eq(bootstrap.id, 1));
  if (!state?.ready || state.semanticsVersion !== ACCEPTANCE_CANDIDATE_SEMANTICS_VERSION)
    throw acceptanceCandidatesUnknown('初始化未完成或判法版本不匹配');
  if ((await acceptanceDirtyGroupsQuery(db, 1)).length)
    throw acceptanceCandidatesUnknown('仍有变化待重算，下一轮继续');
}

/** 完整同task/PR上下文的正式builder，供刷新、纯读和执行计划共同使用。 */
export function acceptanceGroupDutiesQuery(db: Db, key: { taskId: string; prNumber: number }, limit: number) {
  return db
    .select()
    .from(acceptanceDuties)
    .where(and(eq(acceptanceDuties.taskId, key.taskId), eq(acceptanceDuties.prNumber, key.prNumber)))
    .orderBy(asc(acceptanceDuties.id))
    .limit(limit);
}

/**
 * 无锁读取组 revision → 完整原责任 → shared 判法 → revision CAS。
 * 不删除空组（避免 revision 重置的 ABA），不持组锁等 duty 锁；CAS 后到达的写者仍会置 dirty。
 * observed 来自公平队列，过期时明确回 false，不能把新失效清掉。
 */
export async function refreshAcceptanceCandidateGroup(
  db: Db,
  observed: typeof groups.$inferSelect,
  maxDuties: number,
): Promise<{ published: boolean; read: number }> {
  await db
    .update(groups)
    .set({ lastAttemptAt: sql`clock_timestamp()` })
    .where(and(eq(groups.taskId, observed.taskId), eq(groups.prNumber, observed.prNumber)));
  const duties = await acceptanceGroupDutiesQuery(db, observed, maxDuties + 1);
  if (duties.length > maxDuties) throw acceptanceCandidatesUnknown('组内责任超过本轮预算');
  const hasOpen = duties.some((d) => acceptanceDutyState(d, duties) === 'open');
  const updated = await db
    .update(groups)
    .set({ dirty: false, hasOpen })
    .where(
      and(
        eq(groups.taskId, observed.taskId),
        eq(groups.prNumber, observed.prNumber),
        eq(groups.revision, observed.revision),
        sql`${groups.dirty}`,
        sql`exists (select 1 from ${bootstrap} where ${bootstrap.id} = 1 and ${bootstrap.ready} and ${bootstrap.semanticsVersion} = ${ACCEPTANCE_CANDIDATE_SEMANTICS_VERSION})`,
      ),
    )
    .returning({ revision: groups.revision });
  return { published: updated.length === 1, read: duties.length };
}

/** 持久 cursor 接续历史初始化；每批只取键，不把历史 items 载入 Node。 */
async function bootstrapBatch(db: Db, limit: number) {
  // trigger 自迁移提交起已覆盖新写；捕获高水位之前发生的新写也已登记。
  // 缺控制行时可重启初始化（包括测试清库），不覆盖已有 cursor。
  await db.execute(sql`insert into ${bootstrap} (id, semantics_version, high_water_id)
    values (1, ${ACCEPTANCE_CANDIDATE_SEMANTICS_VERSION},
      coalesce((select id from ${acceptanceDuties} order by id desc limit 1), 0))
    on conflict (id) do nothing`);
  return db.transaction(async (tx) => {
    // 仅控制行串行化初始化者；不锁 duty，writer 不取这个控制锁。
    const [state] = await tx.select().from(bootstrap).where(eq(bootstrap.id, 1)).for('update');
    if (!state || state.semanticsVersion !== ACCEPTANCE_CANDIDATE_SEMANTICS_VERSION)
      throw acceptanceCandidatesUnknown('判法版本不匹配，须正式迁移重建');
    if (state.ready) return true;
    const page = await tx
      .select({
        id: acceptanceDuties.id,
        taskId: acceptanceDuties.taskId,
        prNumber: acceptanceDuties.prNumber,
      })
      .from(acceptanceDuties)
      .where(and(gt(acceptanceDuties.id, state.cursorId), lte(acceptanceDuties.id, state.highWaterId)))
      .orderBy(asc(acceptanceDuties.id))
      .limit(limit);
    // ID游标决定进度；组锁必须按task/pr统一序，与statement writer同序。
    const keys = [...new Map(page.map((row) => [`${row.taskId}:${row.prNumber}`, row])).values()].sort(
      (a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.prNumber - b.prNumber),
    );
    for (const row of keys) {
      // 任务已被并发删除时不复活组；不覆盖新写者已递增的 revision。
      await tx.execute(sql`insert into ${groups} (task_id, pr_number)
        select ${row.taskId}::uuid, ${row.prNumber} from tasks where id = ${row.taskId}::uuid
        on conflict (task_id, pr_number) do nothing`);
    }
    const ready = page.length < limit || page.at(-1)?.id === state.highWaterId;
    await tx
      .update(bootstrap)
      .set({ cursorId: page.at(-1)?.id ?? state.highWaterId, ready })
      .where(eq(bootstrap.id, 1));
    return ready;
  });
}

/**
 * 每次最多 2048 历史键 / 128 dirty 组 / 16384 原责任；超预算保留进度并报 unknown。
 * 初始化 O(N) 只付一次，稳态 O(D + ΣH(D))；失败不报“没有责任”。
 */
export async function maintainAcceptanceCandidates(
  db: Db,
  budget: { bootstrapRows?: number; groups?: number; duties?: number } = {},
) {
  const limits = {
    bootstrapRows: budget.bootstrapRows ?? 2048,
    groups: budget.groups ?? 128,
    duties: budget.duties ?? 16384,
  };
  for (const [key, value] of Object.entries(limits)) {
    const max = key === 'bootstrapRows' ? 2048 : key === 'groups' ? 128 : 16384;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`无效候选维护预算：${key}`);
  }
  if (!(await bootstrapBatch(db, limits.bootstrapRows)))
    throw acceptanceCandidatesUnknown('历史初始化尚未完成，游标已保存');
  const dirty = await acceptanceDirtyGroupsQuery(db, limits.groups);
  let remaining = limits.duties;
  for (const row of dirty) {
    if (remaining === 0) break;
    const result = await refreshAcceptanceCandidateGroup(db, row, Math.min(4096, remaining));
    remaining -= result.read;
  }
  // 一次只尝试每组一次；CAS失败的热组已更新lastAttempt，后来的组不会永远饿死。
  await assertAcceptanceCandidatesReady(db);
}
