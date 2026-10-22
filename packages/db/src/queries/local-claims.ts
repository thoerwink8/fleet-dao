// 本机领单（决定 0096，shared 的 local-claims.ts）：本机会话领一张单、续租、结束，和法国拉单收回到期的租约。
// 写的都是 tasks 那一行（executor、lease_until、claimed_by，状态只用引擎认的那几个），每一下同一事务记一条操作记录。
// 读不到、写不成照抛，不拿空顶。
import type { LocalClaimRefusal, LocalFinishOutcome, TaskExecutor, TaskState } from '@fleet-dao/shared';
import { LOCAL_LEASE_MS } from '@fleet-dao/shared';
import { and, arrayContains, asc, desc, eq, gt, gte, isNull, like, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, pullRequests, repos, runs, taskExecutionOperations, tasks } from '../schema/index.ts';

/** 操作记录的动作名（A4 的统计按它认「本机领过、放过」）。 */
export const LOCAL_CLAIM_AUDIT = {
  claim: 'task.local.claim',
  renew: 'task.local.renew',
  finish: 'task.local.finish',
  expire: 'task.local.expire',
  takeoverConfirm: 'task.local.takeover_confirm',
} as const;

export type LocalClaimResult =
  | { ok: true; taskId: string; state: TaskState; executor: TaskExecutor; leaseUntil: Date | null }
  | { ok: false; code: LocalClaimRefusal; why: string };

/** 引擎手上的单：在跑、停下等人、排着要起。本机不抢（停下等人的除外，见 isParked：本机 claim 一步接手）。 */
const ENGINE_HOLDS: readonly TaskState[] = ['queued', 'running', 'stalled'];

/** 引擎已经停下等人：stalled，或 running 但工作流停在 parked 那一步。只有这两种本机 claim 能接手。 */
const isParked = (row: { state: TaskState; phase: string | null }) =>
  row.state === 'stalled' || (row.state === 'running' && row.phase === 'parked');

/** 接手时回调的那一口：后端替本机把引擎的任务工作流叫停（发 taskAbandon，note「本机接手」）。不成就带原因，整个领单回滚。 */
export type TakeOverEngine = (task: {
  taskId: string;
  issueNumber: number;
  state: TaskState;
  doing: string | null;
}) => Promise<{ ok: true } | { ok: false; why: string }>;

export const TAKEOVER_NOTE = '本机接手';

/** 受管接手（已有 PR 的单）：精确 PR 号 + 完整 head；后端自己现核，回调只负责读/叫停引擎的那一个精确 run。 */
export interface WorkflowIdentity {
  workflowId: string;
  runId: string;
  running: boolean;
}
export type ReadWorkflow = (task: {
  taskId: string;
  issueNumber: number;
}) => Promise<({ ok: true } & WorkflowIdentity) | { ok: false; why: string }>;
export type SignalRun = (
  task: { taskId: string; issueNumber: number },
  run: WorkflowIdentity,
) => Promise<{ ok: true } | { ok: false; why: string }>;
export interface TakeoverPr {
  pr: number;
  head: string;
  readWorkflow: ReadWorkflow;
  signalRun: SignalRun;
}

async function repoIdOf(db: Pick<Db, 'select'>, slug: string): Promise<string | null> {
  const [owner, name] = slug.split('/');
  if (!owner || !name) return null;
  const [row] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(sql`lower(${repos.owner}) = lower(${owner})`, sql`lower(${repos.name}) = lower(${name})`));
  return row?.id ?? null;
}

const unknownRepo = (slug: string): LocalClaimResult => ({
  ok: false,
  code: 'unknown_repo',
  why: `${slug} 不是法国管的仓（repos 表里没有），登记不了`,
});

/**
 * 本机领一张单：没有任务行就建一行（running、local、带租约）；引擎手上排队、在跑的不让领，回原因写明现在在干什么；
 * 引擎已经停下等人的（stalled，或 running 而 phase = parked）一步接手：同一事务里先锁行、叫引擎放弃这个任务（takeOver，
 * 没给就不接手、照旧拒）、再改 executor = local、记租约和操作记录（reason「本机接手」）；
 * 本机已领着的当续租；引擎做完、失败、叫停的改成本机在做。
 */
export async function claimLocalTask(
  db: Db,
  input: {
    repo: string;
    issueNumber: number;
    title: string;
    nodeId: string;
    now: Date;
    takeOver?: TakeOverEngine | undefined;
    /** 给了就走受管接手（单上有原 PR）：另一条协议，见 takeoverLocalTask。 */
    takeoverPr?: TakeoverPr | undefined;
  },
): Promise<LocalClaimResult> {
  if (input.takeoverPr) return takeoverLocalTask(db, { ...input, takeoverPr: input.takeoverPr });
  const leaseUntil = new Date(input.now.getTime() + LOCAL_LEASE_MS);
  return db.transaction(async (tx) => {
    const repoId = await repoIdOf(tx, input.repo);
    if (!repoId) return unknownRepo(input.repo);
    const [row] = await tx
      .select({
        id: tasks.id,
        state: tasks.state,
        executor: tasks.executor,
        phase: tasks.phase,
        doing: tasks.doing,
      })
      .from(tasks)
      .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, input.issueNumber)))
      .for('update');
    let tookOver = false;
    if (row && row.executor !== 'local' && ENGINE_HOLDS.includes(row.state)) {
      if (!(isParked(row) && input.takeOver)) {
        const what = row.doing ? `现在在干：${row.doing}` : '没有进度说明';
        return {
          ok: false,
          code: 'engine_has_it',
          why: `法国引擎手上有这张单（状态 ${row.state}${row.phase ? `，阶段 ${row.phase}` : ''}，${what}），本机不接；停下等人的才能 claim 一步接手，在跑的要本机做先在驾驶舱叫停它`,
        } as const;
      }
      const stopped = await input.takeOver({
        taskId: row.id,
        issueNumber: input.issueNumber,
        state: row.state,
        doing: row.doing,
      });
      if (!stopped.ok) {
        return {
          ok: false,
          code: 'engine_has_it',
          why: `法国引擎停着这张单（状态 ${row.state}），但叫停它没成，本机没接：${stopped.why}`,
        } as const;
      }
      tookOver = true;
    }
    const before = row
      ? { state: row.state, executor: row.executor, ...(tookOver ? { phase: row.phase } : {}) }
      : null;
    let taskId: string;
    if (row) {
      await tx
        .update(tasks)
        .set({
          state: 'running',
          executor: 'local',
          leaseUntil,
          claimedBy: input.nodeId,
          phase: null,
          lastProblem: null,
          doing: tookOver ? '本机接手，引擎任务已叫停' : '本机在做',
          updatedAt: input.now,
        })
        .where(eq(tasks.id, row.id));
      taskId = row.id;
    } else {
      const [created] = await tx
        .insert(tasks)
        .values({
          repoId,
          issueNumber: input.issueNumber,
          title: input.title,
          rawRequest: input.title,
          requestedBy: `node:${input.nodeId}`,
          state: 'running',
          priority: sql`(select coalesce(max(${tasks.priority}), 0) + 1 from ${tasks} where ${tasks.repoId} = ${repoId})`,
          executor: 'local',
          leaseUntil,
          claimedBy: input.nodeId,
          doing: '本机在做',
          updatedAt: input.now,
        })
        .returning({ id: tasks.id });
      if (!created) throw new Error(`${input.repo}#${input.issueNumber} 的任务行没建成`);
      taskId = created.id;
    }
    await tx.insert(auditLog).values({
      at: input.now,
      actorKind: 'agent',
      actorId: `node:${input.nodeId}`,
      action: row?.executor === 'local' ? LOCAL_CLAIM_AUDIT.renew : LOCAL_CLAIM_AUDIT.claim,
      target: `task:${taskId}`,
      before,
      after: { state: 'running', executor: 'local', leaseUntil: leaseUntil.toISOString() },
      ...(tookOver ? { reason: TAKEOVER_NOTE } : {}),
      via: 'agent',
    });
    return { ok: true, taskId, state: 'running', executor: 'local', leaseUntil } as const;
  });
}

const TAKEOVER_PENDING_DOING = '本机接手中：等原工作流确认终态';
const TAKEOVER_DONE_DOING = '本机接手完成，原 PR 保留';

const takeoverRefused = (why: string) => ({ ok: false, code: 'takeover_refused', why }) as const;
const takeoverPending = (why: string) => ({ ok: false, code: 'takeover_pending', why }) as const;

/** 原 PR 现核（读 PR 镜像）：这张单开着的 PR 必须正好一个、号和完整 head 对上、分支是引擎受管前缀。回 null 表示对得上，否则是拒绝原因。 */
async function takeoverPrProblem(
  tx: Pick<Db, 'select'>,
  repoId: string,
  issueNumber: number,
  want: { pr: number; head: string },
): Promise<string | null> {
  const open = await tx
    .select({ number: pullRequests.number, headRef: pullRequests.headRef, headSha: pullRequests.headSha })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'open'),
        or(
          arrayContains(pullRequests.issueRefs, [issueNumber]),
          like(pullRequests.headRef, `fleet/${issueNumber}-%`),
          like(pullRequests.headRef, `local/${issueNumber}-%`),
        ),
      ),
    );
  if (open.length !== 1) {
    return `这张单在本仓开着的 PR 有 ${open.length} 个（${open.map((p) => `#${p.number}`).join('、') || '无'}），只接手唯一的原 PR #${want.pr}，不忽略别的`;
  }
  const [only] = open;
  if (only?.number !== want.pr) return `开着的 PR 是 #${only?.number}，不是要接手的 #${want.pr}`;
  if (!only.headRef.startsWith(`fleet/${issueNumber}-`))
    return `PR #${want.pr} 的分支 ${only.headRef} 不是本单的引擎受管分支 fleet/${issueNumber}-`;
  if (only.headSha.toLowerCase() !== want.head) {
    return `PR #${want.pr} 的 head 是 ${only.headSha}，和请求的 ${want.head} 对不上（换过头），不接手`;
  }
  return null;
}

/** 持久协调边界：这张任务有没有未结清的受管执行操作（task_execution_operations 里非 resolved 的）；有就不推进。 */
async function openOperation(tx: Pick<Db, 'select'>, taskId: string): Promise<string | null> {
  const [op] = await tx
    .select({ phase: taskExecutionOperations.phase, kind: taskExecutionOperations.kind })
    .from(taskExecutionOperations)
    .where(and(eq(taskExecutionOperations.taskId, taskId), ne(taskExecutionOperations.phase, 'resolved')))
    .limit(1);
  return op ? `这张任务有未结清的受管执行操作（${op.kind}，${op.phase}），持久协调边界不放行` : null;
}

async function unfinishedRuns(tx: Pick<Db, 'select'>, taskId: string): Promise<number> {
  const rows = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), isNull(runs.endedAt)))
    .limit(1);
  return rows.length;
}

interface RecordedTakeover {
  pr: number;
  head: string;
  workflowId: string;
  runId: string;
}

/** 本机接手那一条 claim 操作记录里记下的原身份（PR、head、原 workflow/run）；没有回 null。 */
async function recordedTakeover(tx: Pick<Db, 'select'>, taskId: string): Promise<RecordedTakeover | null> {
  const [row] = await tx
    .select({ takeover: sql<unknown>`${auditLog.after}->'takeover'` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.target, `task:${taskId}`),
        eq(auditLog.action, LOCAL_CLAIM_AUDIT.claim),
        eq(auditLog.ok, true),
        sql`${auditLog.after}->'takeover' is not null`,
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(1);
  const v = row?.takeover as Partial<RecordedTakeover> | null | undefined;
  if (
    !v ||
    typeof v.pr !== 'number' ||
    typeof v.head !== 'string' ||
    typeof v.workflowId !== 'string' ||
    typeof v.runId !== 'string'
  )
    return null;
  return { pr: v.pr, head: v.head, workflowId: v.workflowId, runId: v.runId };
}

/**
 * 受管接手一张有原 PR 的停下的单（第一步：登记责任，不宣称交接完成）。
 * 同一事务里锁行，依次现核：原 PR 唯一且号/head/分支对上；没有未结束的 run；没有未结清的受管执行操作；
 * 行是引擎明确停下的（stalled / running+parked，或 stopped 且工作流已不在跑）。核过才对「刚读到的那个精确 run」发 taskAbandon，
 * 再改 local + 租约并把原 PR/head/workflow/run 记进操作记录。不等工作流终态（等的话会和需要同一把行锁的收尾互相卡死）：终态由 confirmLocalTakeover 另查。
 * 同一接手重入（本机已领着、记录的身份一致）只续租；别人已领着、或身份不一致一律拒，不覆盖赢家。
 */
async function takeoverLocalTask(
  db: Db,
  input: {
    repo: string;
    issueNumber: number;
    nodeId: string;
    now: Date;
    takeoverPr: TakeoverPr;
  },
): Promise<LocalClaimResult> {
  const leaseUntil = new Date(input.now.getTime() + LOCAL_LEASE_MS);
  const { pr, head, readWorkflow, signalRun } = input.takeoverPr;
  return db.transaction(async (tx) => {
    const repoId = await repoIdOf(tx, input.repo);
    if (!repoId) return unknownRepo(input.repo);
    const [row] = await tx
      .select({
        id: tasks.id,
        state: tasks.state,
        executor: tasks.executor,
        phase: tasks.phase,
        claimedBy: tasks.claimedBy,
      })
      .from(tasks)
      .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, input.issueNumber)))
      .for('update');
    if (!row) return takeoverRefused(`${input.repo}#${input.issueNumber} 没有任务行，没有可接手的原单`);
    const prProblem = await takeoverPrProblem(tx, repoId, input.issueNumber, { pr, head });
    if (prProblem) return takeoverRefused(prProblem);
    if (await unfinishedRuns(tx, row.id)) {
      return takeoverRefused('这张任务还有未结束的 run（工人可能还活着），不接手；不会放弃或取消它');
    }
    const op = await openOperation(tx, row.id);
    if (op) return takeoverRefused(op);

    if (row.executor === 'local') {
      const prior = await recordedTakeover(tx, row.id);
      if (
        row.state === 'running' &&
        row.claimedBy === input.nodeId &&
        prior &&
        prior.pr === pr &&
        prior.head === head
      ) {
        await tx.update(tasks).set({ leaseUntil, updatedAt: input.now }).where(eq(tasks.id, row.id));
        return { ok: true, taskId: row.id, state: 'running', executor: 'local', leaseUntil } as const;
      }
      return takeoverRefused(`这张单已是本机在做（${row.claimedBy ?? '？'}），不是同一次接手，不覆盖`);
    }
    const parked = isParked(row);
    if (!parked && row.state !== 'stopped') {
      return takeoverRefused(
        `引擎没有明确停下这张单（状态 ${row.state}${row.phase ? `，阶段 ${row.phase}` : ''}），不接手`,
      );
    }
    const task = { taskId: row.id, issueNumber: input.issueNumber };
    const wf = await readWorkflow(task);
    if (!wf.ok) return takeoverRefused(`读不到原工作流身份，不接手：${wf.why}`);
    if (parked && wf.running) {
      const signalled = await signalRun(task, wf);
      if (!signalled.ok) {
        return {
          ok: false,
          code: 'engine_has_it',
          why: `叫停原工作流没成（行原样，重跑可恢复）：${signalled.why}`,
        } as const;
      }
    } else if (!parked && wf.running) {
      return takeoverRefused('任务行是 stopped 但原工作流仍在运行，身份对不上，不接手');
    }
    await tx
      .update(tasks)
      .set({
        state: 'running',
        executor: 'local',
        leaseUntil,
        claimedBy: input.nodeId,
        phase: null,
        lastProblem: null,
        doing: TAKEOVER_PENDING_DOING,
        updatedAt: input.now,
      })
      .where(eq(tasks.id, row.id));
    await tx.insert(auditLog).values({
      at: input.now,
      actorKind: 'agent',
      actorId: `node:${input.nodeId}`,
      action: LOCAL_CLAIM_AUDIT.claim,
      target: `task:${row.id}`,
      before: { state: row.state, executor: row.executor, phase: row.phase },
      after: {
        state: 'running',
        executor: 'local',
        leaseUntil: leaseUntil.toISOString(),
        takeover: { pr, head, workflowId: wf.workflowId, runId: wf.runId },
      },
      reason: TAKEOVER_NOTE,
      via: 'agent',
    });
    return { ok: true, taskId: row.id, state: 'running', executor: 'local', leaseUntil } as const;
  });
}

/**
 * 受管接手第二步：确认交接完成。只读现核，不等工作流、不发信号：
 * 本机仍领着且租约在、记录的 PR/head 一致、原 PR 还对得上、没有未结束的 run、原工作流是记录的那个 run 且已结束，才回 ok。
 * 工作流还在跑 / run 还没收 / 读不到 → takeover_pending（责任仍在本机，稍后重确认）；身份对不上 → takeover_refused。
 */
export async function confirmLocalTakeover(
  db: Db,
  input: {
    repo: string;
    issueNumber: number;
    nodeId: string;
    now: Date;
    pr: number;
    head: string;
    readWorkflow: ReadWorkflow;
  },
): Promise<LocalClaimResult> {
  return db.transaction(async (tx) => {
    const repoId = await repoIdOf(tx, input.repo);
    if (!repoId) return unknownRepo(input.repo);
    const [row] = await tx
      .select({
        id: tasks.id,
        state: tasks.state,
        executor: tasks.executor,
        claimedBy: tasks.claimedBy,
        leaseUntil: tasks.leaseUntil,
        doing: tasks.doing,
      })
      .from(tasks)
      .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, input.issueNumber)))
      .for('update');
    if (row?.executor !== 'local' || row.state !== 'running' || row.claimedBy !== input.nodeId) {
      return notClaimed(input.repo, input.issueNumber, row ?? null);
    }
    if (!row.leaseUntil || row.leaseUntil < input.now) {
      return takeoverRefused('本机租约已到期，交接不算数：重跑 pnpm work claim … --takeover-pr 重新登记');
    }
    const prior = await recordedTakeover(tx, row.id);
    if (!prior || prior.pr !== input.pr || prior.head !== input.head) {
      return takeoverRefused('这张单没有记录同一次（PR、head）的接手，不确认');
    }
    const prProblem = await takeoverPrProblem(tx, repoId, input.issueNumber, input);
    if (prProblem) return takeoverRefused(prProblem);
    const op = await openOperation(tx, row.id);
    if (op) return takeoverRefused(op);
    const wf = await input.readWorkflow({ taskId: row.id, issueNumber: input.issueNumber });
    if (!wf.ok) return takeoverPending(`读不到原工作流状态，交接未确认：${wf.why}`);
    if (wf.workflowId !== prior.workflowId || wf.runId !== prior.runId) {
      return takeoverRefused('原工作流现在的 run 和接手时记录的不是同一个（可能起了新一代），不确认');
    }
    if (wf.running) return takeoverPending('原工作流还没确认结束，交接未完成');
    if (await unfinishedRuns(tx, row.id))
      return takeoverPending('原工作流已结束但还有未结束的 run，交接未完成');
    if (row.doing !== TAKEOVER_DONE_DOING) {
      await tx
        .update(tasks)
        .set({ doing: TAKEOVER_DONE_DOING, updatedAt: input.now })
        .where(eq(tasks.id, row.id));
      await tx.insert(auditLog).values({
        at: input.now,
        actorKind: 'agent',
        actorId: `node:${input.nodeId}`,
        action: LOCAL_CLAIM_AUDIT.takeoverConfirm,
        target: `task:${row.id}`,
        before: { doing: row.doing },
        after: { pr: input.pr, head: input.head, workflowId: wf.workflowId, runId: wf.runId },
        reason: TAKEOVER_NOTE,
        via: 'agent',
      });
    }
    return {
      ok: true,
      taskId: row.id,
      state: 'running',
      executor: 'local',
      leaseUntil: row.leaseUntil,
    } as const;
  });
}

async function localRow(tx: Pick<Db, 'select'>, repoId: string, issueNumber: number) {
  const [row] = await tx
    .select({ id: tasks.id, state: tasks.state, executor: tasks.executor })
    .from(tasks)
    .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, issueNumber)))
    .for('update');
  return row ?? null;
}

const notClaimed = (slug: string, issue: number, row: { state: string; executor: string } | null) =>
  ({
    ok: false,
    code: 'not_claimed',
    why: row
      ? `${slug}#${issue} 现在不是本机在做（${row.executor}，${row.state}）：租约可能已到期退回法国，先 pnpm work claim ${issue} 重新领`
      : `${slug}#${issue} 没有任务行：先 pnpm work claim ${issue}`,
  }) as const;

/** 续租：只有本机在做（running + local）的行能续。 */
export async function renewLocalTask(
  db: Db,
  input: { repo: string; issueNumber: number; nodeId: string; now: Date },
): Promise<LocalClaimResult> {
  const leaseUntil = new Date(input.now.getTime() + LOCAL_LEASE_MS);
  return db.transaction(async (tx) => {
    const repoId = await repoIdOf(tx, input.repo);
    if (!repoId) return unknownRepo(input.repo);
    const row = await localRow(tx, repoId, input.issueNumber);
    if (row?.executor !== 'local' || row.state !== 'running') {
      return notClaimed(input.repo, input.issueNumber, row);
    }
    await tx.update(tasks).set({ leaseUntil, claimedBy: input.nodeId }).where(eq(tasks.id, row.id));
    return { ok: true, taskId: row.id, state: 'running', executor: 'local', leaseUntil } as const;
  });
}

/**
 * 本机结束：done 记做完；failed 记失败（还是本机的账，法国不自动接）；released 放手，退回法国队列（stopped + engine，
 * 拉单下一轮按「stopped 且没有任何一代」接手，以前跑过的按「重新派」起下一代）。只有本机在做的行能结束。
 */
export async function finishLocalTask(
  db: Db,
  input: {
    repo: string;
    issueNumber: number;
    outcome: LocalFinishOutcome;
    reason?: string | undefined;
    nodeId: string;
    now: Date;
  },
): Promise<LocalClaimResult> {
  return db.transaction(async (tx) => {
    const repoId = await repoIdOf(tx, input.repo);
    if (!repoId) return unknownRepo(input.repo);
    const row = await localRow(tx, repoId, input.issueNumber);
    if (row?.executor !== 'local' || row.state !== 'running') {
      return notClaimed(input.repo, input.issueNumber, row);
    }
    const end = endOf(input.outcome, input.reason ?? null);
    await tx
      .update(tasks)
      .set({ ...end, leaseUntil: null, updatedAt: input.now })
      .where(eq(tasks.id, row.id));
    await tx.insert(auditLog).values({
      at: input.now,
      actorKind: 'agent',
      actorId: `node:${input.nodeId}`,
      action: LOCAL_CLAIM_AUDIT.finish,
      target: `task:${row.id}`,
      before: { state: row.state, executor: row.executor },
      after: { state: end.state, executor: end.executor, outcome: input.outcome },
      reason: input.reason ?? null,
      via: 'agent',
    });
    return { ok: true, taskId: row.id, state: end.state, executor: end.executor, leaseUntil: null } as const;
  });
}

function endOf(outcome: LocalFinishOutcome, reason: string | null) {
  if (outcome === 'done') {
    return { state: 'done', executor: 'local', doing: '本机做完', lastProblem: null } as const;
  }
  if (outcome === 'failed') {
    return {
      state: 'failed',
      executor: 'local',
      doing: '本机没做成',
      lastProblem: reason ?? '本机没做成',
    } as const;
  }
  return {
    state: 'stopped',
    executor: 'engine',
    claimedBy: null,
    doing: '本机放手，退回法国队列',
    lastProblem: reason ?? '本机放手',
  } as const;
}

export interface ExpiredLocalClaim {
  taskId: string;
  issueNumber: number;
  leaseUntil: Date;
  claimedBy: string | null;
}

/** 这个仓里本机在做、租约已经过了 now 的行，按到期先后。 */
export async function expiredLocalClaims(db: Db, repoId: string, now: Date): Promise<ExpiredLocalClaim[]> {
  const rows = await db
    .select({
      taskId: tasks.id,
      issueNumber: tasks.issueNumber,
      leaseUntil: tasks.leaseUntil,
      claimedBy: tasks.claimedBy,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.repoId, repoId),
        eq(tasks.executor, 'local'),
        eq(tasks.state, 'running'),
        lt(tasks.leaseUntil, now),
      ),
    )
    .orderBy(asc(tasks.leaseUntil));
  return rows.flatMap((r) => (r.leaseUntil ? [{ ...r, leaseUntil: r.leaseUntil }] : []));
}

/**
 * 还没到期的本机租约，键是 `owner/name#单号`（仓名大小写不计）。
 * 到期的、不是本机在做的、没有租约时刻的都不在里面。
 */
export async function activeLocalLeaseKeys(db: Db, now: Date): Promise<Set<string>> {
  const rows = await db
    .select({ owner: repos.owner, name: repos.name, issueNumber: tasks.issueNumber })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(and(eq(tasks.executor, 'local'), eq(tasks.state, 'running'), gte(tasks.leaseUntil, now)));
  return new Set(rows.map((r) => `${r.owner.toLowerCase()}/${r.name.toLowerCase()}#${r.issueNumber}`));
}

/**
 * 读口（GET /api/nodes/claims，#3388）：所有仓里 executor = local 且租约未到期的行，只给仓（owner/name 原样）、单号、claimed_by、
 * lease_until 四样，按仓、单号排。没有 claimed_by 的行（不该有）claimedBy 是空串，不跳过、不编名字。
 */
export async function listLocalClaims(
  db: Db,
  now: Date,
): Promise<{ repo: string; issue: number; claimedBy: string; leaseUntil: Date }[]> {
  const rows = await db
    .select({
      owner: repos.owner,
      name: repos.name,
      issueNumber: tasks.issueNumber,
      claimedBy: tasks.claimedBy,
      leaseUntil: tasks.leaseUntil,
    })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(and(eq(tasks.executor, 'local'), gt(tasks.leaseUntil, now)))
    .orderBy(asc(repos.owner), asc(repos.name), asc(tasks.issueNumber));
  return rows.flatMap((r) =>
    r.leaseUntil
      ? [
          {
            repo: `${r.owner}/${r.name}`,
            issue: r.issueNumber,
            claimedBy: r.claimedBy ?? '',
            leaseUntil: r.leaseUntil,
          },
        ]
      : [],
  );
}

/** 这个仓里本机在做、租约还没到期的行（单关了就提前收的候选），按到期先后。 */
export async function unexpiredLocalClaims(db: Db, repoId: string, now: Date): Promise<ExpiredLocalClaim[]> {
  const rows = await db
    .select({
      taskId: tasks.id,
      issueNumber: tasks.issueNumber,
      leaseUntil: tasks.leaseUntil,
      claimedBy: tasks.claimedBy,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.repoId, repoId),
        eq(tasks.executor, 'local'),
        eq(tasks.state, 'running'),
        gte(tasks.leaseUntil, now),
      ),
    )
    .orderBy(asc(tasks.leaseUntil));
  return rows.flatMap((r) => (r.leaseUntil ? [{ ...r, leaseUntil: r.leaseUntil }] : []));
}

/** 看到还活着的迹象（心跳、开着的 PR），租约顺延到 until。只动仍是本机在做的行；回改了几行。 */
export async function extendLocalLease(db: Db, taskId: string, until: Date): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ leaseUntil: until })
    .where(and(eq(tasks.id, taskId), eq(tasks.executor, 'local'), eq(tasks.state, 'running')))
    .returning({ id: tasks.id });
  return rows.length;
}

/**
 * 法国拉单收回一条到期的租约：returned = 退回法国队列（stopped + engine）；done = 单已经关了、有合并的 PR 挂着（本机做完忘了报）；
 * closed = 单关了、没有合并的 PR（stopped，还是本机的账）。只动仍是本机在做、租约仍过期的行（中途续上了就不动）；回改了几行。
 * early = true：单关了、PR 合了，租约没到期也收（不用等 2 小时、不用手动 pnpm work done）：不看租约时刻，只收 done。
 */
export async function settleExpiredLocalClaim(
  db: Db,
  input: { taskId: string; how: 'returned' | 'done' | 'closed'; why: string; now: Date; early?: boolean },
): Promise<number> {
  return db.transaction(async (tx) => {
    const set: { state: TaskState; executor?: TaskExecutor; claimedBy?: null; doing: string } =
      input.how === 'returned'
        ? { state: 'stopped', executor: 'engine', claimedBy: null, doing: '本机租约到期，退回法国队列' }
        : input.how === 'done'
          ? { state: 'done', doing: '本机做完（单已关、PR 已合）' }
          : { state: 'stopped', doing: '单已关，本机没报结果' };
    const rows = await tx
      .update(tasks)
      .set({ ...set, leaseUntil: null, lastProblem: input.why, updatedAt: input.now })
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.executor, 'local'),
          eq(tasks.state, 'running'),
          ...(input.early ? [] : [lt(tasks.leaseUntil, input.now)]),
        ),
      )
      .returning({ id: tasks.id });
    if (rows.length === 0) return 0;
    await tx.insert(auditLog).values({
      at: input.now,
      actorKind: 'engine',
      actorId: 'engine:intake',
      action: LOCAL_CLAIM_AUDIT.expire,
      target: `task:${input.taskId}`,
      before: { state: 'running', executor: 'local' },
      after: { state: set.state, executor: input.how === 'returned' ? 'engine' : 'local', how: input.how },
      reason: input.why,
      via: 'engine',
    });
    return rows.length;
  });
}

/**
 * 这张任务行最近一次「退回法国队列」的时刻（操作记录里读，不加列、不加迁移）：
 * 租约到期退回（`task.local.expire` 且 how = returned），或本机主动放手（`task.local.finish` 且 outcome = released）。
 * 从没退回过回 null。拉单靠它认出「退回之后一直没人接」的行（jobs/dispatch-standing.ts 的「重新派」）。
 */
export async function lastLocalReturnAt(db: Pick<Db, 'select'>, taskId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: auditLog.at })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.target, `task:${taskId}`),
        eq(auditLog.ok, true),
        or(
          and(eq(auditLog.action, LOCAL_CLAIM_AUDIT.expire), sql`${auditLog.after}->>'how' = 'returned'`),
          and(eq(auditLog.action, LOCAL_CLAIM_AUDIT.finish), sql`${auditLog.after}->>'outcome' = 'released'`),
        ),
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row?.at ?? null;
}

/**
 * 这张单有没有合并了的 PR（PR 镜像里「需求」栏挂着它，或分支是它的固定前缀 fleet/<单号>-、local/<单号>-）：有回号最小的那个，没有回 null。
 * 镜像由 GitHub 事件和对账写，晚几分钟是常态：只用来给「单已关」的那一行判做完还是停下。
 */
export async function mergedPrForIssue(db: Db, repoId: string, issueNumber: number): Promise<number | null> {
  const [row] = await db
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'merged'),
        or(
          arrayContains(pullRequests.issueRefs, [issueNumber]),
          like(pullRequests.headRef, `fleet/${issueNumber}-%`),
          like(pullRequests.headRef, `local/${issueNumber}-%`),
        ),
      ),
    )
    .orderBy(asc(pullRequests.number))
    .limit(1);
  return row?.number ?? null;
}
