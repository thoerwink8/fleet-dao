// 本机领单（决定 0096，shared 的 local-claims.ts）：本机会话领一张单、续租、结束，和法国拉单收回到期的租约。
// 写的都是 tasks 那一行（executor、lease_until、claimed_by，状态只用引擎认的那几个），每一下同一事务记一条操作记录。
// 读不到、写不成照抛，不拿空顶。
import type { LocalClaimRefusal, LocalFinishOutcome, TaskExecutor, TaskState } from '@fleet-dao/shared';
import { LOCAL_LEASE_MS } from '@fleet-dao/shared';
import { and, arrayContains, asc, eq, gte, like, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, pullRequests, repos, tasks } from '../schema/index.ts';

/** 操作记录的动作名（A4 的统计按它认「本机领过、放过」）。 */
export const LOCAL_CLAIM_AUDIT = {
  claim: 'task.local.claim',
  renew: 'task.local.renew',
  finish: 'task.local.finish',
  expire: 'task.local.expire',
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
  },
): Promise<LocalClaimResult> {
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
 * 拉单下一轮按「stopped 且没有任何一代」接手）。只有本机在做的行能结束。
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
