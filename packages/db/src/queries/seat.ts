// 认领账的读写语句（#299，specs/299-帅位只一个/方案.md 第二节；帅位座位整张删掉见 #531）。
// 判法在 @fleet-dao/core 的 seat.ts，把几条语句串进一个事务、记操作记录的是 @fleet-dao/api 的 seat-store.ts；
// 这里只有语句本身。
// 改这里之前必须知道：
// - 时间一律用库的 now()（事务开始的时刻）：心跳写它，读回时把它一起交出去（毫秒数），判过期用它，不用调用方的钟。
// - 抢认领都是一条语句（insert … on conflict … returning）：两边同时来只有一边拿到，不靠先读后写。
import { randomUUID } from 'node:crypto';
import { requirementWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { and, eq, getTableColumns, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, issueClaims, repos, tasks } from '../schema/index.ts';

export type IssueClaimRow = typeof issueClaims.$inferSelect;
export type ClaimOwnerKindRow = IssueClaimRow['ownerKind'];
export type ClaimStateRow = IssueClaimRow['state'];

/** 库的 now()，毫秒数（两种驱动都读成数字）。 */
const nowMs = sql<number>`floor(extract(epoch from now()) * 1000)::float8`.mapWith(Number);
/** 只有一行的表：认领那一行不在时也读得到库的 now()。 */
const ONE_ROW = sql`(values (1)) as one (x)`;
const toDate = (ms: number) => new Date(ms);

export const ACTIVE_CLAIM_STATE_ROWS: readonly ClaimStateRow[] = [
  'pending_start',
  'claimed',
  'doing',
  'pr_open',
];
const ENDED: readonly ClaimStateRow[] = ['done', 'released', 'voided'];

export interface WithNow<T> {
  value: T;
  /** 库的 now()。 */
  now: Date;
}

/** 库的 now()。 */
export async function readDbNow(db: Db): Promise<Date> {
  const [row] = await db.select({ now: nowMs }).from(ONE_ROW);
  if (!row) throw new Error('读库的时钟时连一行都没回（select 一行常量也没回来）');
  return toDate(row.now);
}

// —— 认领 ——

export interface NewClaimRow {
  repoId: string;
  issueNumber: number;
  claimId: string;
  ownerKind: ClaimOwnerKindRow;
  ownerMachine: string | null;
  ownerLabel: string | null;
  seatScope: string | null;
  seatTerm: number | null;
  /** 引擎新认领是待起（交单、接活），写快照时补的是在做；本机的是认领了。 */
  state: 'pending_start' | 'claimed' | 'doing';
  workflowId: string | null;
  graceMinutes: number;
  note: string | null;
}

/**
 * 抢这张单：一条语句。没有行就建；有行但已经结束了（done / released / voided）就整行换成新的认领；还活着就不动、回 null
 * （调用方再读是谁拿着）。两边同时来，后到的那条在冲突上等先到的提交，再按这里的条件判：只有一边拿到。
 */
export async function takeClaimRow(db: Db, input: NewClaimRow): Promise<WithNow<IssueClaimRow> | null> {
  const ended = inArray(issueClaims.state, [...ENDED]);
  const [row] = await db
    .insert(issueClaims)
    .values({
      ...input,
      prNumbers: sql`'{}'::integer[]`,
      claimedAt: sql`now()`,
      heartbeatAt: sql`now()`,
      updatedAt: sql`now()`,
      endedAt: null,
      endReason: null,
    })
    .onConflictDoUpdate({
      target: [issueClaims.repoId, issueClaims.issueNumber],
      set: {
        claimId: sql`excluded.claim_id`,
        ownerKind: sql`excluded.owner_kind`,
        ownerMachine: sql`excluded.owner_machine`,
        ownerLabel: sql`excluded.owner_label`,
        seatScope: sql`excluded.seat_scope`,
        seatTerm: sql`excluded.seat_term`,
        state: sql`excluded.state`,
        workflowId: sql`excluded.workflow_id`,
        prNumbers: sql`'{}'::integer[]`,
        graceMinutes: sql`excluded.grace_minutes`,
        claimedAt: sql`now()`,
        heartbeatAt: sql`now()`,
        updatedAt: sql`now()`,
        endedAt: sql`null`,
        endReason: sql`null`,
        note: sql`excluded.note`,
      },
      setWhere: ended,
    })
    .returning({ ...getTableColumns(issueClaims), now: nowMs });
  if (!row) return null;
  const { now, ...claim } = row;
  return { value: claim, now: toDate(now) };
}

/** 读一张单的认领（没有是 null）和库的 now。lock 给 true 就 `for update` 锁住（事务里改之前用）。 */
export async function readClaim(
  db: Db,
  repoId: string,
  issueNumber: number,
  lock = false,
): Promise<WithNow<IssueClaimRow | null>> {
  const which = and(eq(issueClaims.repoId, repoId), eq(issueClaims.issueNumber, issueNumber));
  if (lock) {
    const [row] = await db
      .select({ ...getTableColumns(issueClaims), now: nowMs })
      .from(issueClaims)
      .where(which)
      .for('update');
    if (!row) return { value: null, now: await readDbNow(db) };
    const { now, ...claim } = row;
    return { value: claim, now: toDate(now) };
  }
  const [row] = await db
    .select({ now: nowMs, claim: issueClaims })
    .from(ONE_ROW)
    .leftJoin(issueClaims, which);
  if (!row) throw new Error('读认领时库连一行都没回（select 一行常量也没回来）');
  return { value: row.claim, now: toDate(row.now) };
}

/**
 * 工人报一步（心跳）：认领号对得上、还活着才写。note 给了就换成这一句；pr 给了就记进 pr_numbers（记过的不重复）、状态到开了 PR；
 * 刚认领的报第一步就到在做。对不上回 null（调用方再读现在归谁）。
 */
export async function stepClaimRow(
  db: Db,
  input: {
    repoId: string;
    issueNumber: number;
    claimId: string;
    note?: string | undefined;
    pr?: number | undefined;
  },
): Promise<WithNow<IssueClaimRow> | null> {
  const pr = input.pr;
  const [row] = await db
    .update(issueClaims)
    .set({
      heartbeatAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(pr !== undefined
        ? {
            prNumbers: sql`case when ${pr}::integer = any(${issueClaims.prNumbers}) then ${issueClaims.prNumbers} else array_append(${issueClaims.prNumbers}, ${pr}::integer) end`,
            state: 'pr_open' as const,
          }
        : {
            state: sql`case when ${issueClaims.state} = 'claimed' then 'doing' else ${issueClaims.state} end`,
          }),
    })
    .where(
      and(
        eq(issueClaims.repoId, input.repoId),
        eq(issueClaims.issueNumber, input.issueNumber),
        eq(issueClaims.claimId, input.claimId),
        inArray(issueClaims.state, ['claimed', 'doing', 'pr_open']),
      ),
    )
    .returning({ ...getTableColumns(issueClaims), now: nowMs });
  if (!row) return null;
  const { now, ...claim } = row;
  return { value: claim, now: toDate(now) };
}

/** 结束一份认领（做完、放下、作废）：认领号对得上、还活着才写。对不上回 null。 */
export async function endClaimRow(
  db: Db,
  input: {
    repoId: string;
    issueNumber: number;
    claimId: string;
    state: 'done' | 'released' | 'voided';
    reason: string;
  },
): Promise<WithNow<IssueClaimRow> | null> {
  const [row] = await db
    .update(issueClaims)
    .set({ state: input.state, endedAt: sql`now()`, updatedAt: sql`now()`, endReason: input.reason })
    .where(
      and(
        eq(issueClaims.repoId, input.repoId),
        eq(issueClaims.issueNumber, input.issueNumber),
        eq(issueClaims.claimId, input.claimId),
        inArray(issueClaims.state, [...ACTIVE_CLAIM_STATE_ROWS]),
      ),
    )
    .returning({ ...getTableColumns(issueClaims), now: nowMs });
  if (!row) return null;
  const { now, ...claim } = row;
  return { value: claim, now: toDate(now) };
}

/**
 * 作废过了宽限期没心跳的本机认领（引擎的不按心跳作废）：一条语句，按库的 now 判，回作废了的那几行。
 * limit 防一次扫太多；剩下的下一轮再扫。
 */
export async function voidExpiredClaimRows(
  db: Db,
  input: { limit: number },
): Promise<WithNow<IssueClaimRow[]>> {
  const due = db
    .select({ repoId: issueClaims.repoId, issueNumber: issueClaims.issueNumber })
    .from(issueClaims)
    .where(
      and(
        inArray(issueClaims.state, ['claimed', 'doing', 'pr_open']),
        sql`${issueClaims.ownerKind} <> 'engine'`,
        lt(issueClaims.heartbeatAt, sql`now() - make_interval(mins => ${issueClaims.graceMinutes})`),
      ),
    )
    .limit(input.limit)
    .for('update', { skipLocked: true });
  const rows = await db
    .update(issueClaims)
    .set({
      state: 'voided',
      endedAt: sql`now()`,
      updatedAt: sql`now()`,
      endReason: sql`'过了宽限期（' || ${issueClaims.graceMinutes} || ' 分钟）没心跳'`,
    })
    .where(sql`(${issueClaims.repoId}, ${issueClaims.issueNumber}) in (${due})`)
    .returning({ ...getTableColumns(issueClaims), now: nowMs });
  const now = rows[0]?.now;
  return {
    value: rows.map(({ now: _now, ...claim }) => claim),
    now: now === undefined ? await readDbNow(db) : toDate(now),
  };
}

/** 列认领：只要活着的（默认），或全部；可以只看一个仓。按仓、单号排。 */
export async function listClaimRows(
  db: Db,
  input: { repoId?: string | undefined; activeOnly: boolean },
): Promise<WithNow<IssueClaimRow[]>> {
  const where = and(
    input.repoId === undefined ? undefined : eq(issueClaims.repoId, input.repoId),
    input.activeOnly ? inArray(issueClaims.state, [...ACTIVE_CLAIM_STATE_ROWS]) : undefined,
  );
  const rows = await db
    .select({ ...getTableColumns(issueClaims) })
    .from(issueClaims)
    .where(where)
    .orderBy(issueClaims.repoId, issueClaims.issueNumber);
  return { value: rows, now: await readDbNow(db) };
}

// —— 引擎的认领 ——

/** 引擎的认领在操作记录里记在这个名下：和 @fleet-dao/api 的 seat-store.ts 里引擎那一份是同一个。 */
const ENGINE_CLAIM_ACTOR = 'fusion';

/** 引擎的认领起成了工作流：待起 → 在做。只改引擎自己的、还在待起的；不是就回 null（调用方再读现在是什么样）。 */
export async function startEngineClaimRow(
  db: Db,
  input: { repoId: string; issueNumber: number },
): Promise<WithNow<IssueClaimRow> | null> {
  const [row] = await db
    .update(issueClaims)
    .set({ state: 'doing', heartbeatAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(issueClaims.repoId, input.repoId),
        eq(issueClaims.issueNumber, input.issueNumber),
        eq(issueClaims.ownerKind, 'engine'),
        eq(issueClaims.state, 'pending_start'),
      ),
    )
    .returning({ ...getTableColumns(issueClaims), now: nowMs });
  if (!row) return null;
  const { now, ...claim } = row;
  return { value: claim, now: toDate(now) };
}

/**
 * 待起超过 minutes 分钟还没改成在做的引擎认领（按库的 now），老的在前，最多 limit 张：GitHub 对账照行里的工作流编号补起。
 * 演练座位下的不算（演练里引擎那一边只抢认领、不起工作流）。
 */
export async function listStalePendingEngineClaimRows(
  db: Db,
  input: { minutes: number; limit: number },
): Promise<WithNow<IssueClaimRow[]>> {
  const rows = await db
    .select({ ...getTableColumns(issueClaims) })
    .from(issueClaims)
    .where(
      and(
        eq(issueClaims.ownerKind, 'engine'),
        eq(issueClaims.state, 'pending_start'),
        lt(issueClaims.updatedAt, sql`now() - make_interval(mins => ${input.minutes})`),
        sql`(${issueClaims.seatScope} is null or ${issueClaims.seatScope} not like 'drill:%')`,
      ),
    )
    .orderBy(issueClaims.updatedAt)
    .limit(input.limit);
  return { value: rows, now: await readDbNow(db) };
}

/**
 * 写任务快照的同一个事务里，这张单上引擎的认领跟着任务走。end 给了（任务结束了）：还活着的引擎认领结束掉、记一条操作记录
 * （claim.done / claim.release）。没给（工作流在跑）：还在待起的改成在做；这张单一份还活着的认领都没有（认领上线前起的任务、
 * 交单时起工作流超时其实起成了），补一份引擎的（在做）、记 claim.take——引擎在做的单库里就归引擎，本机抢不走。
 * 本机的认领一概不碰（本机拿着时补不上，照旧归本机）。回改了、补了的那一行（没动是 null）。
 */
export async function followTaskOnEngineClaim(
  tx: Db,
  input: { taskId: string; end: { state: 'done' | 'released'; reason: string } | null },
): Promise<IssueClaimRow | null> {
  const ofTask = sql`(${issueClaims.repoId}, ${issueClaims.issueNumber}) = (select ${tasks.repoId}, ${tasks.issueNumber} from ${tasks} where ${tasks.id} = ${input.taskId})`;
  const audit = (row: IssueClaimRow, action: string, reason: string) =>
    tx.insert(auditLog).values({
      actorKind: 'engine',
      actorId: ENGINE_CLAIM_ACTOR,
      action,
      target: `claim:${row.repoId}#${row.issueNumber}`,
      after: { claimId: row.claimId, owner: 'engine', state: row.state },
      reason,
      via: 'engine',
    });
  const end = input.end;
  if (end) {
    const [row] = await tx
      .update(issueClaims)
      .set({ state: end.state, endedAt: sql`now()`, updatedAt: sql`now()`, endReason: end.reason })
      .where(
        and(
          ofTask,
          eq(issueClaims.ownerKind, 'engine'),
          inArray(issueClaims.state, [...ACTIVE_CLAIM_STATE_ROWS]),
        ),
      )
      .returning();
    if (!row) return null;
    await audit(row, end.state === 'done' ? 'claim.done' : 'claim.release', end.reason);
    return row;
  }
  const [started] = await tx
    .update(issueClaims)
    .set({ state: 'doing', heartbeatAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(ofTask, eq(issueClaims.ownerKind, 'engine'), eq(issueClaims.state, 'pending_start')))
    .returning();
  if (started) return started;
  const [task] = await tx
    .select({ repoId: tasks.repoId, issueNumber: tasks.issueNumber, owner: repos.owner, name: repos.name })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(eq(tasks.id, input.taskId));
  if (!task) return null;
  const adopted = await takeClaimRow(tx, {
    repoId: task.repoId,
    issueNumber: task.issueNumber,
    claimId: randomUUID(),
    ownerKind: 'engine',
    ownerMachine: null,
    ownerLabel: null,
    seatScope: null,
    seatTerm: null,
    state: 'doing',
    workflowId: requirementWorkflowId({ owner: task.owner, name: task.name }, task.issueNumber),
    // 引擎的认领不按心跳作废，这一格用不上：填默认（和 core 的默认值同一个数）
    graceMinutes: 120,
    note: '引擎在做这张单，库里却没有还活着的认领：写快照时补上',
  });
  if (!adopted) return null;
  await audit(adopted.value, 'claim.take', '引擎在做这张单，库里却没有还活着的认领：写快照时补上');
  return adopted.value;
}
