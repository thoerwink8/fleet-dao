// 账号池上的会话：Fusion 的会话（session_runs）和三段的一次性会话（runs，加上选定了路由、还没开跑时预占着的名额
// pool_reservations）并起来看，各自经路由连到池。选路要的会话事实都从这里读，一份并法：池上还开着的（quota.ts 的 poolOccupancy
// 数池的并发，候选路由和额度表都用它；选路按路由数熔断半开时在途的试探；session-org.ts 的 openOrgRuns 切号前数带组织类型的池上
// 还开着的）、近几天结束的（选路的熔断和战绩）、花了多少（估算类的池的用量）。各写各的就会一处数得着、一处数不着：#735 选路只数了
// session_runs，三段的会话不占池的名额；#758 熔断、战绩、估算也只读 session_runs，三段的会话连着失败不熔断、花的钱不进估算；
// #757 三段的一段从选定路由到写下开跑那一行之间（建树、等内存）谁都数不着，一批单同时选路就把拼车池派超。
// 哪张表读不了都照常抛：读不全就不知道池满没满、路由坏没坏、额度用了多少，当成没有三段的会话会把池派超、派到坏路由上、把池估宽。
//
// 三段的一段预占名额的一辈子（#757），写 pool_reservations 的只有这个文件：
// 1. 选路派出去那一刻占（reservePoolSlot）：锁住池那一行再数、数完没满才写，几张单同时选路也只放得进上限那么多；
// 2. 开跑那一行写进 runs 时同一个事务里收掉（admitRun）：名额从「预占着」变成「在跑」，中间没有谁都数不着的空当；
// 3. 没开跑就收场了（建树失败、内存一直放不下、被叫停、切号停下、换了路由）由引擎放掉（releaseReservation）；
// 4. 都没赶上的到 expires_at 自己不算（卡死了不一直占着），这一段要是后来又开跑，开跑时按当时的空位重新排、满了就不让起；
// 5. 引擎重启时整表清掉（clearReservations）：上一轮的会话一个都起不来了。
import { SEGMENT_STAGE, type StageKind } from '@fleet-dao/shared';
import { and, eq, gt, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  poolReservations,
  pools,
  type RoutedSegment,
  type RunRouteOutcome,
  type RunSegment,
  routes,
  runs,
  sessionRuns,
} from '../schema/index.ts';
import { type RunInsert, startRun } from './runs.ts';

/** 账号池上还没结束的一次会话。 */
export interface OpenPoolRun {
  /** 会话的编号；一次性会话预占着名额、还没开跑的，是预占的编号（pool_reservations.id）。 */
  runId: string;
  poolId: string;
  /** 跑在哪条路由上：选路按路由数熔断半开时在途的试探。 */
  routeId: string;
  /**
   * 哪一种：session = Fusion 的会话（session_runs）；oneShot = 三段的一次性会话（runs 里开跑写下的那一行，或选定了路由、
   * 还没开跑时预占着的名额 pool_reservations）。
   */
  kind: 'session' | 'oneShot';
  /** 选定的时刻：Fusion 是排队时刻；一次性会话开跑了是开跑时刻，还预占着名额的是选中的时刻。 */
  queuedAt: Date;
  /**
   * 进程起来了（Fusion 登记了开工、一次性会话写下了开跑那一行）；null = 选定了、还没开工（Fusion 在建树、准备；一次性会话
   * 预占着名额在建树、等内存），或起之前就没了下文。
   */
  startedAt: Date | null;
  /**
   * 这一次是哪一段（用途）：Fusion 是会话登记的 stage；三段的一次性会话按 shared 的 SEGMENT_STAGE 换（动手 execute、验收 verify）。
   * null = 对不上用途（对题段不选路，正常不会带路由）。驾驶舱「在跑的会话」按它分段显示。
   */
  stage: StageKind | null;
}

/**
 * 还没结束（ended_at 为空）的会话，加上还没过期（expires_at 晚于 now）的预占，按选定的时刻排；orgPoolsOnly 只要带组织类型的池
 * （Claude 订阅：拼车、独享）上的。now 只用来判预占过没过期，默认现在。
 * runs 里 route_id 为空的行不算：连不到路由就不知道它占的是哪个池的名额，算到哪个池都是猜。这种是 #157 加 route_id 之前的
 * 老行、不经选路起的会话；选路派出去的一次性会话开跑那一行都带 route_id（engine 的 runner/one-shot.ts）。
 */
export async function openPoolRuns(
  db: Db,
  options: { orgPoolsOnly?: boolean; now?: Date } = {},
): Promise<OpenPoolRun[]> {
  const orgOnly = options.orgPoolsOnly ? [isNotNull(pools.orgKind)] : [];
  const now = options.now ?? new Date();
  const [sessions, oneShots, reservations] = await Promise.all([
    db
      .select({
        runId: sessionRuns.id,
        poolId: routes.poolId,
        routeId: routes.id,
        queuedAt: sessionRuns.queuedAt,
        startedAt: sessionRuns.startedAt,
        stage: sessionRuns.stage,
      })
      .from(sessionRuns)
      .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .where(and(isNull(sessionRuns.endedAt), ...orgOnly)),
    db
      .select({
        runId: runs.id,
        poolId: routes.poolId,
        routeId: routes.id,
        startedAt: runs.startedAt,
        segment: runs.segment,
      })
      .from(runs)
      .innerJoin(routes, eq(routes.id, runs.routeId))
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .where(and(isNull(runs.endedAt), ...orgOnly)),
    db
      .select({
        runId: poolReservations.id,
        poolId: routes.poolId,
        routeId: routes.id,
        reservedAt: poolReservations.reservedAt,
        segment: poolReservations.segment,
      })
      .from(poolReservations)
      .innerJoin(routes, eq(routes.id, poolReservations.routeId))
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .where(and(gt(poolReservations.expiresAt, now), ...orgOnly)),
  ]);
  return [
    ...sessions.map((s) => ({ ...s, kind: 'session' as const })),
    ...oneShots.map((r) => ({
      runId: r.runId,
      poolId: r.poolId,
      routeId: r.routeId,
      kind: 'oneShot' as const,
      queuedAt: r.startedAt,
      startedAt: r.startedAt,
      stage: stageOfSegment(r.segment),
    })),
    ...reservations.map((h) => ({
      runId: h.runId,
      poolId: h.poolId,
      routeId: h.routeId,
      kind: 'oneShot' as const,
      queuedAt: h.reservedAt,
      startedAt: null,
      stage: stageOfSegment(h.segment),
    })),
  ].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime() || byId(a.runId, b.runId));
}

/** 三段的一段对应的用途（shared 的 SEGMENT_STAGE）；对题段不选路，没有。 */
function stageOfSegment(segment: RunSegment): StageKind | null {
  return segment === 'manual' || segment === 'verify' ? SEGMENT_STAGE[segment] : null;
}

/** 一条预占：引擎重启清掉的、预占时顺手收掉的过期的（别的单占着没开跑、也没放掉，那一段多半卡住了）交回给调用方记日志。 */
export interface PoolReservationRow {
  taskId: string;
  segment: RoutedSegment;
  routeId: string;
  reservedAt: Date;
}

export interface PoolReservationRequest {
  /** 哪张单（tasks.id）。 */
  taskId: string;
  segment: RoutedSegment;
  /** 选中的路由。 */
  routeId: string;
  /** 选中的时刻：判池满没满、哪些预占过期了都按它。 */
  reservedAt: Date;
  /** 占到什么时候。 */
  expiresAt: Date;
}

export type PoolReservationResult =
  | { reserved: true; reservationId: string; poolId: string; expired: PoolReservationRow[] }
  /** 池满了：选路读事实到预占之间，空位被别的单占走了。预占的人照当时的事实重新选。 */
  | {
      reserved: false;
      poolId: string;
      occupied: number;
      maxConcurrency: number;
      expired: PoolReservationRow[];
    };

/**
 * 选路派出去那一刻，给这张单的这一段预占一个池的名额。锁住池那一行再数（和 admitRun 同一把锁）：几张单同时选路时排着队数，
 * 后来的看得见先来的占的，满了回 reserved: false、不写。这张单这一段之前占的（上一次选路占了、没开跑也没放掉）先换掉，不和
 * 自己抢名额。只锁池、不管 Fusion 那边：Fusion 起会话不走这把锁，同一刻两边一起派还可能多出一个（Fusion 要删，不为它加锁）。
 */
export async function reservePoolSlot(db: Db, req: PoolReservationRequest): Promise<PoolReservationResult> {
  if (req.expiresAt.getTime() <= req.reservedAt.getTime()) {
    throw new Error(
      `预占的过期时刻（${req.expiresAt.toISOString()}）要晚于选中的时刻（${req.reservedAt.toISOString()}）`,
    );
  }
  return db.transaction(async (tx) => {
    const pool = await lockPoolOf(tx, req.routeId);
    await tx
      .delete(poolReservations)
      .where(and(eq(poolReservations.taskId, req.taskId), eq(poolReservations.segment, req.segment)));
    const expired = await tx
      .delete(poolReservations)
      .where(
        and(
          inArray(
            poolReservations.routeId,
            tx.select({ id: routes.id }).from(routes).where(eq(routes.poolId, pool.id)),
          ),
          lte(poolReservations.expiresAt, req.reservedAt),
        ),
      )
      .returning(reservationColumns);
    const occupied = await occupiedOn(tx, pool.id, req.reservedAt);
    if (occupied >= pool.maxConcurrency) {
      return { reserved: false, poolId: pool.id, occupied, maxConcurrency: pool.maxConcurrency, expired };
    }
    const [row] = await tx
      .insert(poolReservations)
      .values({
        taskId: req.taskId,
        segment: req.segment,
        routeId: req.routeId,
        reservedAt: req.reservedAt,
        expiresAt: req.expiresAt,
      })
      .returning({ id: poolReservations.id });
    if (!row) throw new Error(`预占写进去了却没交回编号（池 ${pool.id}、路由 ${req.routeId}）`);
    return { reserved: true, reservationId: row.id, poolId: pool.id, expired };
  });
}

/** 开跑时池的名额满了：这一段没预占着名额（占的过期了、或没占），空位已经给了别的会话。开跑那一行没写，会话不该起。 */
export class PoolFullError extends Error {
  readonly poolId: string;
  readonly occupied: number;
  readonly maxConcurrency: number;
  constructor(input: { poolId: string; occupied: number; maxConcurrency: number; why: string }) {
    super(
      `池 ${input.poolId} 的名额满了（已经有 ${input.occupied} 个，上限 ${input.maxConcurrency} 个）：${input.why}，开跑那一行没写`,
    );
    this.name = 'PoolFullError';
    this.poolId = input.poolId;
    this.occupied = input.occupied;
    this.maxConcurrency = input.maxConcurrency;
  }
}

/**
 * 开跑时这一段的预占怎么样了：taken = 还占着、换成了这一行；stale = 占的过期了（或占在别的池上），按当时的空位重新排过；
 * none = 没预占（或预占已经不在了），按当时的空位排过。
 */
export type AdmitReservation = 'taken' | 'stale' | 'none';

/**
 * 开跑：在 runs 里留下没结束的那一行（#157），这一次会话就此占上池的名额。和 reservePoolSlot 同一把锁（池那一行）：
 * 给了 reservationId、预占还在、没过期、在同一个池上，就在同一个事务里把它换成这一行（名额从「预占着」变成「在跑」，中间谁都
 * 不会多数或漏数）；没预占（不经选路的老路子）、占的过期了，按当时的空位排：满了抛 PoolFullError、一行不写。
 * 同一个编号再开跑一次（重试）不和自己抢名额。写不进去照常抛（startRun 的 RunInputError），事务整个退回、预占原样留着。
 */
export async function admitRun(
  db: Db,
  row: RunInsert & { id: string; routeId: string; startedAt: Date },
  options: { reservationId?: string } = {},
): Promise<{ reservation: AdmitReservation }> {
  return db.transaction(async (tx) => {
    const pool = await lockPoolOf(tx, row.routeId);
    const [held] =
      options.reservationId === undefined
        ? []
        : await tx
            .delete(poolReservations)
            .where(eq(poolReservations.id, options.reservationId))
            .returning({ routeId: poolReservations.routeId, expiresAt: poolReservations.expiresAt });
    const heldPool = held ? await poolIdOf(tx, held.routeId) : undefined;
    const taken =
      held !== undefined && held.expiresAt.getTime() > row.startedAt.getTime() && heldPool === pool.id;
    if (!taken) {
      const occupied = await occupiedOn(tx, pool.id, row.startedAt, row.id);
      if (occupied >= pool.maxConcurrency) {
        throw new PoolFullError({
          poolId: pool.id,
          occupied,
          maxConcurrency: pool.maxConcurrency,
          why: held
            ? heldPool === pool.id
              ? `选路时预占的名额 ${held.expiresAt.toISOString()} 就过期了（建树、等内存卡得太久），空位让给了别的会话`
              : `选路时预占的名额在池 ${heldPool ?? '（路由已经没了）'} 上，不是这个池`
            : options.reservationId === undefined
              ? '这一次没预占名额'
              : `选路时预占的名额 ${options.reservationId} 已经不在了（过期后被收掉、或引擎重启时清掉）`,
        });
      }
    }
    await startRun(tx, row);
    return { reservation: taken ? 'taken' : held ? 'stale' : 'none' };
  });
}

/** 这一段没开跑就收场了：放掉选路时预占的名额。已经换成开跑那一行的、过期被收掉的，什么都不做（回 false）。 */
export async function releaseReservation(db: Db, reservationId: string): Promise<boolean> {
  const rows = await db
    .delete(poolReservations)
    .where(eq(poolReservations.id, reservationId))
    .returning({ id: poolReservations.id });
  return rows.length > 0;
}

/** 这张单的这一段重新选路：之前预占的作废（它已经不会拿那个名额开跑了），别让它把池占满、挡了自己。 */
export async function releaseTaskReservation(
  db: Db,
  key: { taskId: string; segment: RoutedSegment },
): Promise<boolean> {
  const rows = await db
    .delete(poolReservations)
    .where(and(eq(poolReservations.taskId, key.taskId), eq(poolReservations.segment, key.segment)))
    .returning({ id: poolReservations.id });
  return rows.length > 0;
}

/** 引擎起来、接活之前：上一轮预占着的名额全清掉（那些段一个都起不来了），交回清掉的。 */
export async function clearReservations(db: Db): Promise<PoolReservationRow[]> {
  return db.delete(poolReservations).returning(reservationColumns);
}

const reservationColumns = {
  taskId: poolReservations.taskId,
  segment: poolReservations.segment,
  routeId: poolReservations.routeId,
  reservedAt: poolReservations.reservedAt,
};

/** 锁住这条路由所在的池那一行，交回池和它的并发上限。路由、池库里没有就抛。 */
async function lockPoolOf(db: Db, routeId: string): Promise<{ id: string; maxConcurrency: number }> {
  const poolId = await poolIdOf(db, routeId);
  if (poolId === undefined) throw new Error(`库里没有路由 ${routeId}，不知道它占的是哪个池的名额`);
  const [pool] = await db
    .select({ id: pools.id, maxConcurrency: pools.maxConcurrency })
    .from(pools)
    .where(eq(pools.id, poolId))
    .for('update');
  if (!pool) throw new Error(`库里没有账号池 ${poolId}（路由 ${routeId} 挂着它）`);
  return pool;
}

async function poolIdOf(db: Db, routeId: string): Promise<string | undefined> {
  const [route] = await db.select({ poolId: routes.poolId }).from(routes).where(eq(routes.id, routeId));
  return route?.poolId;
}

/** 这个池上占着的名额（在跑的、选定了还没开工的、预占着的），和选路数的是同一份（openPoolRuns）。 */
async function occupiedOn(db: Db, poolId: string, now: Date, exceptRunId?: string): Promise<number> {
  return (await openPoolRuns(db, { now })).filter((r) => r.poolId === poolId && r.runId !== exceptRunId)
    .length;
}

/** 一次结束了的会话记在路由上的账：选路按路由算熔断、按用途算战绩。 */
export type EndedPoolRun = {
  runId: string;
  routeId: string;
  endedAt: Date;
  /**
   * 算不算这条路由的账（ok、fail、neutral，两张表同一个口径）；空 = 没下过结论（老行、只记流水的那几笔），按不算账读——
   * 熔断当 neutral、战绩不数。
   */
  routeOutcome: RunRouteOutcome | null;
} & (
  | {
      /** Fusion 的会话：选路时的阶段。 */
      kind: 'session';
      stage: StageKind;
    }
  | {
      /** 三段的一次性会话：哪一段。按哪个用途算战绩由选路那边定（shared 的 SEGMENT_STAGE：动手按 execute，验收按 verify）。 */
      kind: 'oneShot';
      segment: RunSegment;
    }
);

/** since 之后结束的会话（两种都要，按结束先后排）。runs 里没写路由的行连不到路由，不算谁的账。 */
export async function endedPoolRuns(db: Db, since: Date): Promise<EndedPoolRun[]> {
  const [sessions, oneShots] = await Promise.all([
    db
      .select({
        runId: sessionRuns.id,
        routeId: sessionRuns.routeId,
        stage: sessionRuns.stage,
        endedAt: sessionRuns.endedAt,
        routeOutcome: sessionRuns.routeOutcome,
      })
      .from(sessionRuns)
      .where(gte(sessionRuns.endedAt, since)),
    db
      .select({
        runId: runs.id,
        routeId: runs.routeId,
        segment: runs.segment,
        endedAt: runs.endedAt,
        routeOutcome: runs.routeOutcome,
      })
      .from(runs)
      .where(and(gte(runs.endedAt, since), isNotNull(runs.routeId))),
  ]);
  // gte、isNotNull 已经把空的排除在外；这里只是不裸用 ! 断言：真出现数据和查询条件对不上时要看得见报错，不是当空处理
  const ended = (at: Date | null, runId: string): Date => {
    if (at === null) throw new Error(`会话 ${runId} 按结束时刻查出来，结束时刻却是空的`);
    return at;
  };
  return [
    ...sessions.map(
      (s): EndedPoolRun => ({
        kind: 'session',
        runId: s.runId,
        routeId: s.routeId,
        stage: s.stage,
        endedAt: ended(s.endedAt, s.runId),
        routeOutcome: s.routeOutcome,
      }),
    ),
    ...oneShots.map((r): EndedPoolRun => {
      if (r.routeId === null) throw new Error(`一次性会话 ${r.runId} 按带路由查出来，路由却是空的`);
      return {
        kind: 'oneShot',
        runId: r.runId,
        routeId: r.routeId,
        segment: r.segment,
        endedAt: ended(r.endedAt, r.runId),
        routeOutcome: r.routeOutcome,
      };
    }),
  ].sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime() || byId(a.runId, b.runId));
}

/** 估算类的池算用量用：这个池的路由在 [since, until] 内开始的会话，各自的 token、花费。 */
export interface PoolRunUsage {
  kind: 'session' | 'oneShot';
  startedAt: Date;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

/**
 * 两种会话都算。没记到花费的会话（cost_usd 为空）照样返回、字段为空：由调用方决定怎么算，这里不拿 0 冒充记到了。
 * Fusion 的会话只看开始了的（started_at 不空）；一次性会话开跑才写那一行，都算。没跑成的也算，它花过的用量记在账上就是用过的。
 * 模型按路由的（两种会话一样），不按 runs.model。
 */
export async function poolRunUsage(
  db: Db,
  q: { poolId: string; since: Date; until: Date },
): Promise<PoolRunUsage[]> {
  const [sessions, oneShots] = await Promise.all([
    db
      .select({
        startedAt: sessionRuns.startedAt,
        modelId: routes.modelId,
        inputTokens: sessionRuns.inputTokens,
        outputTokens: sessionRuns.outputTokens,
        cacheReadTokens: sessionRuns.cacheReadTokens,
        cacheWriteTokens: sessionRuns.cacheWriteTokens,
        costUsd: sessionRuns.costUsd,
      })
      .from(sessionRuns)
      .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
      .where(
        and(
          eq(routes.poolId, q.poolId),
          isNotNull(sessionRuns.startedAt),
          gte(sessionRuns.startedAt, q.since),
          lte(sessionRuns.startedAt, q.until),
        ),
      ),
    db
      .select({
        startedAt: runs.startedAt,
        modelId: routes.modelId,
        inputTokens: runs.inputTokens,
        outputTokens: runs.outputTokens,
        cacheReadTokens: runs.cacheReadTokens,
        cacheWriteTokens: runs.cacheWriteTokens,
        costUsd: runs.costUsd,
      })
      .from(runs)
      .innerJoin(routes, eq(routes.id, runs.routeId))
      .where(and(eq(routes.poolId, q.poolId), gte(runs.startedAt, q.since), lte(runs.startedAt, q.until))),
  ]);
  return [
    ...sessions.flatMap((s) =>
      s.startedAt === null ? [] : [{ ...s, kind: 'session' as const, startedAt: s.startedAt }],
    ),
    ...oneShots.map((r) => ({ ...r, kind: 'oneShot' as const })),
  ].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
