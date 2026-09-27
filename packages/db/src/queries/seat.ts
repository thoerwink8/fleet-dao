// 帅位租约和认领的读写语句（#299，specs/299-帅位只一个/方案.md 第二节）。判法在 @fleet-dao/core 的 seat.ts，把几条语句
// 串进一个事务、记操作记录的是 @fleet-dao/api 的 pg-store.ts；这里只有语句本身。
// 改这里之前必须知道：
// - 时间一律用库的 now()（事务开始的时刻）：心跳、续约写它，读回时把它一起交出去（毫秒数），判过期用它，不用调用方的钟。
// - 接班、抢认领都是一条语句（insert … on conflict … returning）：两边同时来只有一边拿到，不靠先读后写。
// - 受保护动作在同一个事务里先 lockSeat（for share）再写：接班那条要等这个事务提交才能改座位，动作就排在接班之前。
import { and, eq, getTableColumns, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { issueClaims, seatLeases, settings } from '../schema/index.ts';

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

/** 续约：任期、持有人都对得上才续（过了期也续：过期只说明联系不上，没有别人接班就还是它）。对不上回 null。 */
export async function renewSeatRow(
  db: Db,
  input: { scope: string; term: number; machine: string; session: string },
): Promise<WithNow<SeatLeaseRow> | null> {
  const [row] = await db
    .update(seatLeases)
    .set({ renewedAt: sql`now()` })
    .where(
      and(
        eq(seatLeases.scope, input.scope),
        eq(seatLeases.term, input.term),
        eq(seatLeases.holderMachine, input.machine),
        eq(seatLeases.holderSession, input.session),
      ),
    )
    .returning({ ...getTableColumns(seatLeases), now: nowMs });
  if (!row) return null;
  const { now, ...lease } = row;
  return { value: lease, now: toDate(now) };
}

/** 写交接说明（整份换掉），带上写的时刻（库的 now）。调用方先在同一个事务里核过是谁写的。 */
export async function writeHandoffRow(db: Db, input: { scope: string; text: string }): Promise<SeatLeaseRow> {
  const [row] = await db
    .update(seatLeases)
    .set({ handoff: input.text, handoffAt: sql`now()` })
    .where(eq(seatLeases.scope, input.scope))
    .returning();
  if (!row) throw new Error(`写交接说明时座位 ${input.scope} 不在了`);
  return row;
}

/** settings 表里 seat.leaseMinutes、seat.claimGraceMinutes 两项的原值（没写的是 undefined）；认不认得出由 core 的 readSeatSettings 判。 */
export async function readSeatSetting(
  db: Db,
): Promise<{ leaseMinutes?: unknown; claimGraceMinutes?: unknown }> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ['seat.leaseMinutes', 'seat.claimGraceMinutes']));
  const out: { leaseMinutes?: unknown; claimGraceMinutes?: unknown } = {};
  for (const r of rows) {
    if (r.key === 'seat.leaseMinutes') out.leaseMinutes = r.value;
    else out.claimGraceMinutes = r.value;
  }
  return out;
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
  state: 'pending_start' | 'claimed';
  workflowId: string | null;
  graceMinutes: number;
  note: string | null;
}

/**
 * 抢这张单：一条语句。没有行就建；有行但已经结束了（done / released / voided）就整行换成新的认领；还活着就不动、回 null
 * （调用方再读是谁拿着）。两边同时来，后到的那条在冲突上等先到的提交，再按这里的条件判：只有一边拿到。
 */
export async function takeClaimRow(db: Db, input: NewClaimRow): Promise<WithNow<IssueClaimRow> | null> {
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
      setWhere: inArray(issueClaims.state, [...ENDED]),
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
