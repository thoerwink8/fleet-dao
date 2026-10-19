// 已经结束、却被误记成 abandoned 的真实已合任务：读受管账，并在同一事务里 CAS 改任务行、写操作记录。
// 不改 runs、不改 pull_requests、不改 acceptance_duties、不碰 Temporal。审计插入失败时事务回滚，任务行保持原样。
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, pullRequests, repos, runs, tasks } from '../schema/index.ts';

export const CORRECT_MERGED_AUDIT_ACTION = 'task.correct-merged';

/** 审计一次最多读这么多条成功回执。再多就当没读全，拒绝，不挑一条方便的。 */
const AUDIT_LIMIT = 20;

export interface CorrectMergedSessionLink {
  workflowId: string | null;
  prNumber: number | null;
  temporalRunId: string | null;
  ended: boolean;
}

export interface CorrectMergedMirror {
  number: number;
  headSha: string;
  mergeSha: string | null;
  issueRefs: number[];
  state: string;
}

export interface CorrectMergedAuditReceipt {
  before: unknown;
  after: unknown;
}

export interface CorrectMergedLedger {
  task: {
    id: string;
    repo: { owner: string; name: string };
    issueNumber: number;
    state: string;
    phase: string | null;
    executor: 'engine' | 'local';
    updatedAt: string | null;
    openRunCount: number;
  };
  sessions: CorrectMergedSessionLink[];
  /** 请求的那条 PR 在 pull_requests 里的镜像。没有这行是 null，不当成已合。 */
  mirror: CorrectMergedMirror | null;
  corrections: CorrectMergedAuditReceipt[];
}

export interface CasCorrectMergedInput {
  taskId: string;
  expectedUpdatedAtMs: number;
  workflowId: string;
  runId: string;
  prNumber: number;
  now: Date;
  audit: { actorId: string; reason: string; before: unknown; after: unknown };
}

const DOING = '受管纠正为真实已合；原 abandoned 结论留在操作记录和原执行结果';

/** count(*) 有时是字符串。不是非负安全整数就当没读成，不把未知当成没有会话。 */
function countValue(value: unknown): number {
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER))
    return Number(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new Error('活跃会话数读不到');
}

async function openRuns(db: Pick<Db, 'select'>, taskId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<unknown>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), isNull(runs.endedAt)));
  return countValue(row?.n ?? null);
}

function sessionLinks(
  rows: {
    workflowId: string | null;
    prNumber: number | null;
    temporalRunId: string | null;
    endedAt: Date | null;
  }[],
): CorrectMergedSessionLink[] {
  return rows.map((row) => ({
    workflowId: row.workflowId,
    prNumber: row.prNumber,
    temporalRunId: row.temporalRunId,
    ended: row.endedAt !== null,
  }));
}

/**
 * 受管会话账是否仍把这张任务、这条工作流、这个 PR 和这次 run 钉在一起。
 * temporal_run_id 或 PR 号为空的老行不冒充别的交付；一旦同一工作流记下了别的 run，
 * 或同时还存在另一条不同 PR 的会话，就不能靠其中一条对得上的记录放行。
 */
export function sessionLinkHolds(
  sessions: readonly CorrectMergedSessionLink[],
  workflowId: string,
  prNumber: number,
  runId: string,
): boolean {
  const sameWorkflow = sessions.filter((row) => row.workflowId === workflowId);
  const recordedRuns = sameWorkflow.map((row) => row.temporalRunId).filter((id): id is string => id !== null);
  if (recordedRuns.some((id) => id !== runId)) return false;
  const recordedPrs = sameWorkflow.map((row) => row.prNumber).filter((n): n is number => n !== null);
  if (recordedPrs.some((n) => n !== prNumber)) return false;
  return sameWorkflow.some(
    (row) =>
      row.ended && row.prNumber === prNumber && (row.temporalRunId === null || row.temporalRunId === runId),
  );
}

/** 仓或任务不在库里回 null。读不全（多行仓、会话数、审计翻不完）抛错，调用方拒绝，不纠正。 */
export async function readCorrectMergedLedger(
  db: Pick<Db, 'select'>,
  input: { owner: string; name: string; issueNumber: number; prNumber: number },
): Promise<CorrectMergedLedger | null> {
  const repoRows = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(
      and(
        sql`lower(${repos.owner}) = lower(${input.owner})`,
        sql`lower(${repos.name}) = lower(${input.name})`,
      ),
    );
  if (repoRows.length === 0) return null;
  if (repoRows.length > 1) throw new Error('仓名对上了多行，没有唯一的仓，不纠正');
  const repo = repoRows[0];
  if (!repo) return null;
  const [task] = await db
    .select({
      id: tasks.id,
      issueNumber: tasks.issueNumber,
      state: tasks.state,
      phase: tasks.phase,
      executor: tasks.executor,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(eq(tasks.repoId, repo.id), eq(tasks.issueNumber, input.issueNumber)));
  if (!task) return null;
  const openRunCount = await openRuns(db, task.id);
  const sessionRows = await db
    .select({
      workflowId: runs.workflowId,
      prNumber: runs.prNumber,
      temporalRunId: runs.temporalRunId,
      endedAt: runs.endedAt,
    })
    .from(runs)
    .where(eq(runs.taskId, task.id))
    .orderBy(asc(runs.startedAt), asc(runs.id));
  const [mirror] = await db
    .select({
      number: pullRequests.number,
      headSha: pullRequests.headSha,
      mergeSha: pullRequests.mergeSha,
      issueRefs: pullRequests.issueRefs,
      state: pullRequests.state,
    })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.number, input.prNumber)));
  const corrections = await db
    .select({ before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, CORRECT_MERGED_AUDIT_ACTION),
        eq(auditLog.target, `task:${task.id}`),
        eq(auditLog.ok, true),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(AUDIT_LIMIT + 1);
  if (corrections.length > AUDIT_LIMIT) throw new Error('受管纠正的审计记录没有读全，不纠正');
  return {
    task: {
      id: task.id,
      repo: { owner: repo.owner, name: repo.name },
      issueNumber: task.issueNumber,
      state: task.state,
      phase: task.phase,
      executor: task.executor,
      updatedAt: task.updatedAt ? task.updatedAt.toISOString() : null,
      openRunCount,
    },
    sessions: sessionLinks(sessionRows),
    mirror: mirror
      ? {
          number: mirror.number,
          headSha: mirror.headSha,
          mergeSha: mirror.mergeSha,
          issueRefs: mirror.issueRefs,
          state: mirror.state,
        }
      : null,
    corrections,
  };
}

/**
 * 仅当任务行仍是引擎的 stopped/abandoned、更新时间没变、没有开着的会话、会话账仍钉着这次交付时，
 * 改成 done/merged 并写操作记录。同一工作流另有不同 PR 的会话算对不上，回 stale，不写。
 * 审计失败抛错，整笔回滚。
 */
export async function casCorrectMergedTask(
  db: Db,
  input: CasCorrectMergedInput,
): Promise<'corrected' | 'stale'> {
  if (!Number.isSafeInteger(input.expectedUpdatedAtMs)) return 'stale';
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: tasks.id,
        state: tasks.state,
        phase: tasks.phase,
        executor: tasks.executor,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for('update');
    if (!row || row.state !== 'stopped' || row.phase !== 'abandoned' || row.executor !== 'engine')
      return 'stale';
    if (row.updatedAt === null || row.updatedAt.getTime() !== input.expectedUpdatedAtMs) return 'stale';
    if ((await openRuns(tx, row.id)) !== 0) return 'stale';
    const sessionRows = await tx
      .select({
        workflowId: runs.workflowId,
        prNumber: runs.prNumber,
        temporalRunId: runs.temporalRunId,
        endedAt: runs.endedAt,
      })
      .from(runs)
      .where(eq(runs.taskId, row.id));
    if (!sessionLinkHolds(sessionLinks(sessionRows), input.workflowId, input.prNumber, input.runId))
      return 'stale';
    await tx
      .update(tasks)
      .set({
        state: 'done',
        phase: 'merged',
        doing: DOING,
        lastProblem: null,
        updatedAt: input.now,
      })
      .where(eq(tasks.id, row.id));
    await tx.insert(auditLog).values({
      at: input.now,
      actorKind: 'ops',
      actorId: input.audit.actorId,
      action: CORRECT_MERGED_AUDIT_ACTION,
      target: `task:${row.id}`,
      before: input.audit.before ?? null,
      after: input.audit.after ?? null,
      reason: input.audit.reason,
      via: 'ops',
      ok: true,
    });
    return 'corrected';
  });
}
