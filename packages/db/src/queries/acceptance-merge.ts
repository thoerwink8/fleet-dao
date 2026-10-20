// 私有管理CLI的归并事务：网络取证在调用前完成，源责任不变，目标始终待独立验收。
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  acceptanceDuties,
  auditLog,
  idempotencyKeys,
  pullRequests,
  repos,
  runs,
  tasks,
} from '../schema/index.ts';
import type { AcceptanceDutyRow } from './acceptance-duties.ts';

export interface AcceptanceMergeDutyContract {
  id: number;
  generation: number;
  taskId: string;
  repo: string;
  issueNumber: number;
  prNumber: number;
  head: string;
  items: string[];
  source: string;
}
export interface AcceptanceMergeContract {
  repo: string;
  issueNumber: number;
  taskId: string;
  repoId: string;
  workflowId: string;
  temporalRunId: string;
  prNumber: number;
  head: string;
  mergeCommit: string;
  sources: AcceptanceMergeDutyContract[];
  target: AcceptanceMergeDutyContract | null;
  items: string[];
  itemSources: {
    item: string;
    sources: { id: number; generation: number; head: string; existingTarget: boolean }[];
  }[];
  proof: unknown;
}
export function acceptanceMergeDutyContract(r: AcceptanceDutyRow): AcceptanceMergeDutyContract {
  return {
    id: r.id,
    generation: r.generation,
    taskId: r.taskId,
    repo: r.repo,
    issueNumber: r.issueNumber,
    prNumber: r.prNumber,
    head: r.head,
    items: [...r.items].sort(),
    source: r.source,
  };
}
/** 规范化对象键；数组的业务顺序由计划构建者显式固定，不依赖序列化偶然键序。 */
export function acceptanceMergeCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(acceptanceMergeCanonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${acceptanceMergeCanonical(v)}`)
    .join(',')}}`;
}
export const acceptanceMergePlanHash = (c: AcceptanceMergeContract) =>
  createHash('sha256').update(acceptanceMergeCanonical(c)).digest('hex');
interface MergeReceipt {
  version: 1;
  requestHash: string;
  planHash: string;
  contract: AcceptanceMergeContract;
  operator: string;
  target: AcceptanceMergeDutyContract;
  auditId: number;
}
const keyOf = (request: string) => `ops:acceptance-merge:${request}`;
const targetOf = (c: AcceptanceMergeContract) => `task:${c.taskId}:pr:${c.prNumber}:head:${c.head}`;
export async function readAcceptanceMergeReceipt(db: Db, request: string) {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, keyOf(request)));
  if (!row) return null;
  if (row.action !== 'acceptance.merge' || !row.completedAt || !row.result || typeof row.result !== 'object')
    throw new Error('归并请求键冲突或回执不完整');
  const result = row.result as MergeReceipt;
  if (
    result.version !== 1 ||
    !result.contract ||
    row.target !== targetOf(result.contract) ||
    result.planHash !== acceptanceMergePlanHash(result.contract)
  )
    throw new Error('归并回执合同损坏');
  return result;
}
export interface AcceptanceMergeWrite {
  request: string;
  planHash: string;
  by: string;
  reason: string;
  evidence: string;
  contract: AcceptanceMergeContract;
}
export function acceptanceMergeRequestHash(input: AcceptanceMergeWrite) {
  return createHash('sha256')
    .update(
      acceptanceMergeCanonical({
        request: input.request,
        planHash: input.planHash,
        by: input.by,
        reason: input.reason,
        evidence: input.evidence,
        repo: input.contract.repo,
        issueNumber: input.contract.issueNumber,
        taskId: input.contract.taskId,
        workflowId: input.contract.workflowId,
        temporalRunId: input.contract.temporalRunId,
        prNumber: input.contract.prNumber,
        head: input.contract.head,
        mergeCommit: input.contract.mergeCommit,
        sources: input.contract.sources.map((s) => ({ id: s.id, generation: s.generation })),
      }),
    )
    .digest('hex');
}

export async function mergeAcceptanceDuties(db: Db, input: AcceptanceMergeWrite, now: Date) {
  const c = structuredClone(input.contract);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.request) ||
    !input.by.trim() ||
    !input.reason.trim() ||
    !input.evidence.trim() ||
    Buffer.byteLength(input.reason) > 8192 ||
    Buffer.byteLength(input.evidence) > 8192 ||
    input.planHash !== acceptanceMergePlanHash(c) ||
    !c.sources.length ||
    c.sources.length > 64 ||
    c.items.length > 2048 ||
    Buffer.byteLength(JSON.stringify(c.items)) > 1024 * 1024
  )
    throw new Error('归并请求或计划合同不合法');
  const union = [...new Set([...c.sources.flatMap((s) => s.items), ...(c.target?.items ?? [])])].sort();
  if (
    acceptanceMergeCanonical(union) !== acceptanceMergeCanonical(c.items) ||
    c.sources.some(
      (s) =>
        s.taskId !== c.taskId ||
        s.repo !== c.repo ||
        s.issueNumber !== c.issueNumber ||
        s.prNumber !== c.prNumber ||
        s.head === c.head,
    ) ||
    new Set(c.sources.map((s) => s.id)).size !== c.sources.length
  )
    throw new Error('归并计划原项或来源身份矛盾');
  const requestHash = acceptanceMergeRequestHash(input),
    key = keyOf(input.request),
    targetKey = targetOf(c);
  const same = (a: unknown, b: unknown) => acceptanceMergeCanonical(a) === acceptanceMergeCanonical(b);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
    const claimed = await tx
      .insert(idempotencyKeys)
      .values({ key, action: 'acceptance.merge', target: targetKey, claimedAt: now })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    const [request] = await tx
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .for('update');
    if (!request || request.action !== 'acceptance.merge' || request.target !== targetKey)
      throw new Error('归并请求键冲突');
    const prior = request.completedAt ? (request.result as MergeReceipt | null) : null;
    if (
      request.completedAt &&
      (!prior ||
        prior.version !== 1 ||
        prior.requestHash !== requestHash ||
        prior.planHash !== input.planHash ||
        !same(prior.contract, c))
    )
      throw new Error('归并请求已使用，参数、操作者或证据不同');
    // 新建的占键行必定在本事务内；已有未完成键不能被当成本次新请求接手。
    if (!prior && !claimed.length) throw new Error('归并请求已有未完成记录');
    // runs的归属可整行覆盖且无共同键锁；行锁挡不住NULL→匹配或新插入。
    // 此私有短事务暂排队全部run写入；提交后的新写入不属于本次事实快照。
    await tx.execute(sql`LOCK TABLE runs IN SHARE MODE`);
    const linkedRuns = await tx
      .select({ taskId: runs.taskId })
      .from(runs)
      .where(and(eq(runs.workflowId, c.workflowId), eq(runs.temporalRunId, c.temporalRunId)));
    if (linkedRuns.some((r) => r.taskId !== c.taskId))
      throw new Error('归并原run已存关联与任务冲突，请重新核验');
    const [task] = await tx
      .select({
        id: tasks.id,
        repoId: tasks.repoId,
        issueNumber: tasks.issueNumber,
        owner: repos.owner,
        name: repos.name,
      })
      .from(tasks)
      .innerJoin(repos, eq(tasks.repoId, repos.id))
      .where(eq(tasks.id, c.taskId))
      .for('share');
    if (
      !task ||
      task.repoId !== c.repoId ||
      task.issueNumber !== c.issueNumber ||
      `${task.owner}/${task.name}` !== c.repo
    )
      throw new Error('归并任务归属已变，请重新预检');
    const [pr] = await tx
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, c.repoId), eq(pullRequests.number, c.prNumber)))
      .for('update');
    if (!pr || pr.state !== 'merged' || pr.headSha !== c.head || pr.mergeSha !== c.mergeCommit)
      throw new Error('归并PR合并回执已变，请重新预检');
    const ids = [
      ...c.sources.map((s) => s.id),
      ...(prior ? [prior.target.id] : c.target ? [c.target.id] : []),
    ];
    const rows = await tx
      .select()
      .from(acceptanceDuties)
      .where(inArray(acceptanceDuties.id, ids))
      .orderBy(asc(acceptanceDuties.id))
      .for('update');
    for (const expected of c.sources) {
      const row = rows.find((r) => r.id === expected.id);
      if (!row || !same(acceptanceMergeDutyContract(row), expected))
        throw new Error('归并源责任原项或代次已变，旧计划失效');
      if (!prior && (row.settledAt || row.supersededAt)) throw new Error('归并源责任已结清，请重新预检');
    }
    if (prior) {
      const current = rows.find((r) => r.id === prior.target.id);
      if (!current || !same(acceptanceMergeDutyContract(current), prior.target))
        throw new Error('历史归并已完成，但源或目标新增换代，旧计划已失效');
      return { replayed: true, target: current, auditId: prior.auditId, planHash: prior.planHash };
    }
    const [current] = await tx
      .select()
      .from(acceptanceDuties)
      .where(
        and(
          eq(acceptanceDuties.taskId, c.taskId),
          eq(acceptanceDuties.prNumber, c.prNumber),
          eq(acceptanceDuties.head, c.head),
        ),
      );
    if (c.target ? !current || !same(acceptanceMergeDutyContract(current), c.target) : !!current)
      throw new Error('归并目标原项或代次已变，请重新预检');
    if (c.target && c.items.every((item) => c.target!.items.includes(item)))
      throw new Error('没有新增原项，无须归并，请走既有替代入口');
    const values = {
      taskId: c.taskId,
      repo: c.repo,
      issueNumber: c.issueNumber,
      prNumber: c.prNumber,
      head: c.head,
      items: c.items,
      mergeCommit: c.mergeCommit,
      mergedAt: pr.mergedAt,
      source: 'management_merge',
    };
    const [target] = current
      ? await tx
          .update(acceptanceDuties)
          .set({
            items: c.items,
            generation: current.generation + 1,
            mergeCommit: c.mergeCommit,
            mergedAt: pr.mergedAt,
            settledAt: null,
            settledBy: null,
            settleEvidence: null,
            supersededAt: null,
            supersededBy: null,
            supersedeEvidence: null,
            successorId: null,
            successorGeneration: null,
            supersedeCoverage: null,
          })
          .where(
            and(eq(acceptanceDuties.id, current.id), eq(acceptanceDuties.generation, current.generation)),
          )
          .returning()
      : await tx.insert(acceptanceDuties).values(values).onConflictDoNothing().returning();
    if (!target) throw new Error('归并目标并发变化，请重新预检');
    const [audit] = await tx
      .insert(auditLog)
      .values({
        at: now,
        actorKind: 'ops',
        actorId: input.by,
        action: 'acceptance.merge',
        target: targetKey,
        via: 'ops',
        ok: true,
        reason: input.reason,
        before: { target: current ?? null, sources: rows },
        after: {
          target,
          items: c.itemSources,
          proof: c.proof,
          evidence: input.evidence,
          request: input.request,
          planHash: input.planHash,
        },
      })
      .returning({ id: auditLog.id });
    if (!audit) throw new Error('归并审计写入失败');
    const receipt: MergeReceipt = {
      version: 1,
      requestHash,
      planHash: input.planHash,
      contract: c,
      operator: input.by,
      target: acceptanceMergeDutyContract(target),
      auditId: audit.id,
    };
    const [done] = await tx
      .update(idempotencyKeys)
      .set({ completedAt: now, result: receipt })
      .where(eq(idempotencyKeys.key, key))
      .returning({ key: idempotencyKeys.key });
    if (!done) throw new Error('归并回执写入失败');
    return { replayed: false, target, auditId: audit.id, planHash: input.planHash };
  });
}
