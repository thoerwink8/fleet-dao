// 帅位和认领的读写语句（#446，specs/446-帅位认领简化/需求.md）。判法在 @fleet-dao/core 的 seat.ts，把几条语句串进一个
// 事务、记操作记录的是 @fleet-dao/api 的 pg-store.ts；这里只有语句本身。
// 改这里之前必须知道：
// - 时间一律用库的 now()（事务开始的时刻），读回时把它一起交出去（毫秒数），不用调用方的钟。
// - 接班、抢认领都是一条语句（insert … on conflict … returning）：两边同时来只有一边拿到，不靠先读后写。
// - #446 起帅位不再是锁：没有续约、没有「受保护动作前先锁座位核任期」这一步；seat_leases 的 renewed_at 只当「最后活动
//   时间」给人看（touchSeatActivityRow、writeHandoffRow 会顶它），term、holder_* 这些列还在，只是没人拿它们拦写入。
import { randomUUID } from 'node:crypto';
import { requirementWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { and, eq, getTableColumns, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, issueClaims, repos, seatBoards, seatLeases, tasks } from '../schema/index.ts';

export type SeatLeaseRow = typeof seatLeases.$inferSelect;
export type IssueClaimRow = typeof issueClaims.$inferSelect;
export type ClaimOwnerKindRow = IssueClaimRow['ownerKind'];
export type ClaimStateRow = IssueClaimRow['state'];

/** 库的 now()，毫秒数（两种驱动都读成数字）。 */
const nowMs = sql<number>`floor(extract(epoch from now()) * 1000)::float8`.mapWith(Number);
/** 只有一行的表：座位、认领那一行不在时也读得到库的 now()。 */
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

// —— 帅位 ——

/** 读一个座位此刻的样子。lock 给 true 就 `for share` 锁住这一行（受保护动作用，要在事务里）。 */
export async function readSeat(db: Db, scope: string, lock = false): Promise<WithNow<SeatLeaseRow | null>> {
  if (lock) {
    // for share 不能加在外连接可能为空的那一侧：直接查这一行；同一个事务里 now() 都是同一个时刻
    const [row] = await db
      .select({ ...getTableColumns(seatLeases), now: nowMs })
      .from(seatLeases)
      .where(eq(seatLeases.scope, scope))
      .for('share');
    if (!row) return { value: null, now: await readDbNow(db) };
    const { now, ...lease } = row;
    return { value: lease, now: toDate(now) };
  }
  const [row] = await db
    .select({ now: nowMs, lease: seatLeases })
    .from(ONE_ROW)
    .leftJoin(seatLeases, eq(seatLeases.scope, scope));
  if (!row) throw new Error('读座位时库连一行都没回（select 一行常量也没回来）');
  return { value: row.lease, now: toDate(row.now) };
}

/**
 * 接班：一条语句。座位上没人就当第 1 任；有人就任期加一、把原来的持有人抄进 previous_*。不看旧的同不同意、过没过期：
 * 后说的算，任期号一直往上加。
 */
export async function takeSeatRow(
  db: Db,
  input: { scope: string; machine: string; session: string },
): Promise<WithNow<SeatLeaseRow>> {
  const [row] = await db
    .insert(seatLeases)
    .values({
      scope: input.scope,
      term: 1,
      holderMachine: input.machine,
      holderSession: input.session,
      acquiredAt: sql`now()`,
      renewedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: seatLeases.scope,
      set: {
        term: sql`${seatLeases.term} + 1`,
        previousMachine: sql`${seatLeases.holderMachine}`,
        previousSession: sql`${seatLeases.holderSession}`,
        holderMachine: sql`excluded.holder_machine`,
        holderSession: sql`excluded.holder_session`,
        acquiredAt: sql`now()`,
        renewedAt: sql`now()`,
      },
    })
    .returning({ ...getTableColumns(seatLeases), now: nowMs });
  if (!row) throw new Error(`接班没写进去：座位 ${input.scope} 的 insert … on conflict 没回行`);
  const { now, ...lease } = row;
  return { value: lease, now: toDate(now) };
}

/**
 * 帅位真做了件事（写交接、写进度板……）：把 renewed_at 顶成现在，当「最后活动时间」给人看（#446，K8s Lease 的
 * renewTime 那个思路，但没人读它来判断谁能写）。没有这个座位就什么都不做——board 写入不因为帅位没接过班而失败。
 */
export async function touchSeatActivityRow(db: Db, scope: string): Promise<void> {
  await db.update(seatLeases).set({ renewedAt: sql`now()` }).where(eq(seatLeases.scope, scope));
}

/** 写交接说明（整份换掉），同时把 renewed_at 顶成现在（写交接也是活动）。调用方先核过座位在不在。 */
export async function writeHandoffRow(db: Db, input: { scope: string; text: string }): Promise<SeatLeaseRow> {
  const [row] = await db
    .update(seatLeases)
    .set({ handoff: input.text, handoffAt: sql`now()`, renewedAt: sql`now()` })
    .where(eq(seatLeases.scope, input.scope))
    .returning();
  if (!row) throw new Error(`写交接说明时座位 ${input.scope} 不在了`);
  return row;
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
 * seatReservationOf 给了座位名：这个座位的帅位自己占着的（owner 是 seat，开单时替帅位认领的那种）也换——调用方在同一个
 * 事务里核过它就是这个座位的现任帅位（派工人接手帅位占着的单）。
 */
export async function takeClaimRow(
  db: Db,
  input: NewClaimRow,
  options: { seatReservationOf?: string | undefined } = {},
): Promise<WithNow<IssueClaimRow> | null> {
  const scope = options.seatReservationOf;
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
      setWhere:
        scope === undefined
          ? ended
          : (or(ended, and(eq(issueClaims.ownerKind, 'seat'), eq(issueClaims.seatScope, scope))) ?? ended),
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
    // #446 起没有东西按心跳作废认领，这一格用不上：填默认（和 core 的 DEFAULT_CLAIM_GRACE_MINUTES 同一个数）
    graceMinutes: 120,
    note: '引擎在做这张单，库里却没有还活着的认领：写快照时补上',
  });
  if (!adopted) return null;
  await audit(adopted.value, 'claim.take', '引擎在做这张单，库里却没有还活着的认领：写快照时补上');
  return adopted.value;
}

// —— 帅位栏（#199）——

export type SeatBoardRow = typeof seatBoards.$inferSelect;

/** 一个座位下的板，按项目名排。 */
export async function listSeatBoardRows(db: Db, scope: string): Promise<WithNow<SeatBoardRow[]>> {
  const now = await readDbNow(db);
  const rows = await db
    .select()
    .from(seatBoards)
    .where(eq(seatBoards.scope, scope))
    .orderBy(seatBoards.project);
  return { value: rows, now };
}

/** 锁住这一行（要在事务里）。没有是 null。 */
export async function lockSeatBoardRow(
  db: Db,
  scope: string,
  project: string,
): Promise<WithNow<SeatBoardRow | null>> {
  const [row] = await db
    .select({ ...getTableColumns(seatBoards), now: nowMs })
    .from(seatBoards)
    .where(and(eq(seatBoards.scope, scope), eq(seatBoards.project, project)))
    .for('update');
  if (!row) return { value: null, now: await readDbNow(db) };
  const { now, ...board } = row;
  return { value: board, now: toDate(now) };
}

/** 锁住首页要的全部板（scope = main），点选项时用，免得两下同时改同一行。 */
export async function lockMainSeatBoards(db: Db): Promise<WithNow<SeatBoardRow[]>> {
  const rows = await db
    .select({ ...getTableColumns(seatBoards), now: nowMs })
    .from(seatBoards)
    .where(eq(seatBoards.scope, 'main'))
    .orderBy(seatBoards.project)
    .for('update');
  if (rows.length === 0) return { value: [], now: await readDbNow(db) };
  const now = rows[0]?.now;
  if (now === undefined) return { value: [], now: await readDbNow(db) };
  return {
    value: rows.map(({ now: _now, ...board }) => board),
    now: toDate(now),
  };
}

export async function insertSeatBoardRow(
  db: Db,
  row: {
    id: string;
    scope: string;
    project: string;
    headline: string;
    steps: unknown;
    log: unknown;
    needs: unknown;
    answers: unknown;
    updatedAt: Date;
  },
): Promise<SeatBoardRow> {
  const [saved] = await db.insert(seatBoards).values(row).returning();
  if (!saved) throw new Error('写入帅位栏没有返回行');
  return saved;
}

export async function updateSeatBoardRow(
  db: Db,
  row: {
    id: string;
    headline: string;
    steps: unknown;
    log: unknown;
    needs: unknown;
    answers: unknown;
    updatedAt: Date;
  },
): Promise<SeatBoardRow> {
  const [saved] = await db
    .update(seatBoards)
    .set({
      headline: row.headline,
      steps: row.steps,
      log: row.log,
      needs: row.needs,
      answers: row.answers,
      updatedAt: row.updatedAt,
    })
    .where(eq(seatBoards.id, row.id))
    .returning();
  if (!saved) throw new Error(`帅位栏 ${row.id} 锁住了却更新不到`);
  return saved;
}
