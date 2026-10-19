// 已经结束、却被误记成 abandoned 的真实已合任务：读受管账，并在同一事务里 CAS 改任务行、写操作记录。
// 不改 runs、不改 pull_requests、不改 acceptance_duties、不碰 Temporal。审计插入失败时事务回滚，任务行保持原样。
// 受管起代（重做、拉单接手老行）先在任务行锁里落一条起代意图并改更新时间，提交后才去起 Temporal；结果明确才落已结。
// 纠正事务锁同一行：有没结的意图就拒绝；意图落在纠正读账之后，更新时间对不上也拒绝。没有租约，不靠超时放行。
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, pullRequests, repos, runs, tasks } from '../schema/index.ts';

export const CORRECT_MERGED_AUDIT_ACTION = 'task.correct-merged';
export const TASK_START_INTENT_ACTION = 'task.start-intent';
export const TASK_START_SETTLED_ACTION = 'task.start-settled';

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
    /** 有一次受管起代已经发出、结果还没明确。true 就不能纠正。 */
    startPending: boolean;
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

/** 谁要起代。写进起代意图和已结两条操作记录。 */
export interface TaskStartActor {
  kind: 'user' | 'engine' | 'ops';
  id: string;
  via: 'cockpit' | 'engine' | 'ops';
}

export type TaskStartBegun =
  | { ok: true; intent: string }
  | { ok: false; state: string | null; reason?: string };

function serialValue(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error('起代意图读不全');
}

/** 最新一条起代意图比已结覆盖到的还新，就是有一次起代结果未知。读不成就抛，不当成没有。 */
async function startPending(db: Pick<Db, 'select'>, taskId: string): Promise<boolean> {
  const [row] = await db
    .select({
      intent: sql<unknown>`max(${auditLog.id}) filter (where ${auditLog.action} = ${TASK_START_INTENT_ACTION})`,
      settled: sql<unknown>`max((${auditLog.after} ->> 'upTo')::bigint) filter (where ${auditLog.action} = ${TASK_START_SETTLED_ACTION})`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.target, `task:${taskId}`),
        inArray(auditLog.action, [TASK_START_INTENT_ACTION, TASK_START_SETTLED_ACTION]),
      ),
    );
  const intent = serialValue(row?.intent);
  if (intent === null) return false;
  const settled = serialValue(row?.settled);
  return settled === null || settled < intent;
}

/**
 * 受管起代之前调：锁任务行，状态在 allowed 里才落起代意图并改更新时间。提交之后调用方才许去起 Temporal。
 * 纠正先写成 done/merged 的，这里重读到就拒绝。起完、结果明确，再拿意图编号调 settleTaskStart。
 */
export async function beginTaskStart(
  db: Db,
  input: { taskId: string; allowed: readonly string[]; actor: TaskStartActor; now: Date },
): Promise<TaskStartBegun> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for('update');
    if (!row) return { ok: false as const, state: null };
    if (!input.allowed.includes(row.state)) return { ok: false as const, state: row.state };
    if (await startPending(tx, input.taskId)) {
      return {
        ok: false as const,
        state: row.state,
        reason: '这张单已有一次受管起代结果未知，不能再次起代；先核清那次起代',
      };
    }
    const [audit] = await tx
      .insert(auditLog)
      .values({
        at: input.now,
        actorKind: input.actor.kind,
        actorId: input.actor.id,
        action: TASK_START_INTENT_ACTION,
        target: `task:${input.taskId}`,
        after: { state: row.state },
        via: input.actor.via,
        ok: true,
      })
      .returning({ id: auditLog.id });
    if (!audit) throw new Error('起代意图没写进去');
    await tx.update(tasks).set({ updatedAt: input.now }).where(eq(tasks.id, input.taskId));
    return { ok: true as const, intent: String(audit.id) };
  });
}

/**
 * 起代结果明确了（起成，或确定没起）才调。覆盖到这条为止的所有意图：这一次明确的列代晚于更早那次未知的起代。
 * 起代抛错、超时、进程退出都不调，意图一直挂着，纠正一直拒绝。
 */
export async function settleTaskStart(
  db: Db,
  input: { taskId: string; intent: string; outcome: string; actor: TaskStartActor; now: Date },
): Promise<void> {
  if (!/^\d+$/.test(input.intent)) throw new Error('起代意图编号不对');
  const intent = BigInt(input.intent);
  await db.transaction(async (tx) => {
    const [task] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for('update');
    if (!task) throw new Error('任务不在库里，不能结算起代意图');
    const [row] = await tx
      .select({
        latestIntent: sql<unknown>`max(${auditLog.id}) filter (where ${auditLog.action} = ${TASK_START_INTENT_ACTION})`,
        settled: sql<unknown>`max((${auditLog.after} ->> 'upTo')::bigint) filter (where ${auditLog.action} = ${TASK_START_SETTLED_ACTION})`,
      })
      .from(auditLog)
      .where(eq(auditLog.target, `task:${input.taskId}`));
    const latest = serialValue(row?.latestIntent);
    const settled = serialValue(row?.settled);
    if (latest === null || latest !== intent) {
      throw new Error('起代意图已经换代，不能结算旧意图');
    }
    if (settled !== null && settled >= intent) {
      if (settled === intent) return;
      throw new Error('起代意图已经被别的结果覆盖，不能越代结算');
    }
    await tx.insert(auditLog).values({
      at: input.now,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      action: TASK_START_SETTLED_ACTION,
      target: `task:${input.taskId}`,
      after: { upTo: Number(input.intent), outcome: input.outcome },
      via: input.actor.via,
      ok: true,
    });
  });
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
 * 对不上时给出拒绝原因；对得上返回 null。
 * 同一工作流里任意非空 PR 不同于请求都拒绝，不能任取一条匹配会话忽略另一条。
 * 旧行 temporal run 为空又混着别的非空 PR 时，原因写明归属有歧义，不把这些行说成同一次执行的证据。
 * 空 PR、多条相同 PR、别的工作流上的旧 PR 不在这里否决。显式不同的 run 仍单独拒绝。
 * 不要求会话只有一条，也不改历史会话。
 */
export function sessionLinkRefusal(
  sessions: readonly CorrectMergedSessionLink[],
  workflowId: string,
  prNumber: number,
  runId: string,
): string | null {
  const sameWorkflow = sessions.filter((row) => row.workflowId === workflowId);
  const recordedRuns = sameWorkflow.map((row) => row.temporalRunId).filter((id): id is string => id !== null);
  if (recordedRuns.some((id) => id !== runId)) {
    return '受管会话账对不上这次交付（无证据，或 run 记成了别的）';
  }
  const foreign = sameWorkflow.filter((row) => row.prNumber !== null && row.prNumber !== prNumber);
  if (foreign.length > 0) {
    if (foreign.some((row) => row.temporalRunId === null)) {
      return '同一工作流的会话 PR 归属有歧义：另有不同的非空 PR，旧行没有 temporal run，不能当作同一次执行的证据';
    }
    return '同一工作流记下了不同的非空 PR，不能任取一条匹配会话放行';
  }
  const holds = sameWorkflow.some(
    (row) =>
      row.ended && row.prNumber === prNumber && (row.temporalRunId === null || row.temporalRunId === runId),
  );
  if (!holds) return '受管会话账对不上这次交付（无证据，或 run 记成了别的）';
  return null;
}

/** 受管会话账是否仍把这张任务、这条工作流、这个 PR 和这次 run 钉在一起。 */
export function sessionLinkHolds(
  sessions: readonly CorrectMergedSessionLink[],
  workflowId: string,
  prNumber: number,
  runId: string,
): boolean {
  return sessionLinkRefusal(sessions, workflowId, prNumber, runId) === null;
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
      startPending: await startPending(db, task.id),
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
 * 仅当任务行仍是引擎的 stopped/abandoned、更新时间没变、没有没结的起代意图、没有开着的会话、会话账仍钉着这次交付时，
 * 改成 done/merged 并写操作记录。同一工作流另有不同非空 PR（含旧行 temporal run 为空的混合 PR）算对不上，
 * 回 stale，不写。核对之后事务里才看到的冲突会话同样拒绝。审计失败抛错，整笔回滚。
 * expectedUpdatedAtMs 必须来自先于 Temporal 读取的那次读账：之后才落的起代意图会改掉更新时间。事务里不等网络。
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
    if (await startPending(tx, row.id)) return 'stale';
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
