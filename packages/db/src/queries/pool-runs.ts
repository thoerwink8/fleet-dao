// 账号池上的会话：Fusion 的会话（session_runs）和三段的一次性会话（runs）并起来看，各自经路由连到池。选路要的会话事实都从这里读，
// 两张表一份并法：池上还开着的（quota.ts 的 inFlightByPool 数池的并发，候选路由和额度表都用它；选路按路由数熔断半开时在途的
// 试探；session-org.ts 的 openOrgRuns 切号前数带组织类型的池上还开着的）、近几天结束的（选路的熔断和战绩）、花了多少（估算类的
// 池的用量）。各写各的就会一处数得着、一处数不着：#735 选路只数了 session_runs，三段的会话不占池的名额；#758 熔断、战绩、估算
// 也只读 session_runs，三段的会话连着失败不熔断、花的钱不进估算。
// 哪张表读不了都照常抛：读不全就不知道池满没满、路由坏没坏、额度用了多少，当成没有三段的会话会把池派超、派到坏路由上、把池估宽。
import type { StageKind } from '@fleet-dao/shared';
import { and, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { pools, type RunRouteOutcome, type RunSegment, routes, runs, sessionRuns } from '../schema/index.ts';

/** 账号池上还没结束的一次会话。 */
export interface OpenPoolRun {
  runId: string;
  poolId: string;
  /** 跑在哪条路由上：选路按路由数熔断半开时在途的试探。 */
  routeId: string;
  /** 哪一种：session = Fusion 的会话（session_runs）；oneShot = 三段的一次性会话（runs，开跑才写那一行）。 */
  kind: 'session' | 'oneShot';
  /** 一次性会话没有排队这一步，就是开跑时刻。 */
  queuedAt: Date;
  /** 进程起来了（登记了开工）；null = 还在起（建树、准备），或起之前就没了下文。一次性会话总有。 */
  startedAt: Date | null;
}

/**
 * 还没结束（ended_at 为空）的会话，按排队时刻排；orgPoolsOnly 只要带组织类型的池（Claude 订阅：拼车、独享）上的。
 * runs 里 route_id 为空的行不算：连不到路由就不知道它占的是哪个池的名额，算到哪个池都是猜。这种是 #157 加 route_id 之前的
 * 老行、不经选路起的会话；选路派出去的一次性会话开跑那一行都带 route_id（engine 的 runner/one-shot.ts）。
 */
export async function openPoolRuns(db: Db, options: { orgPoolsOnly?: boolean } = {}): Promise<OpenPoolRun[]> {
  const orgOnly = options.orgPoolsOnly ? [isNotNull(pools.orgKind)] : [];
  const [sessions, oneShots] = await Promise.all([
    db
      .select({
        runId: sessionRuns.id,
        poolId: routes.poolId,
        routeId: routes.id,
        queuedAt: sessionRuns.queuedAt,
        startedAt: sessionRuns.startedAt,
      })
      .from(sessionRuns)
      .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .where(and(isNull(sessionRuns.endedAt), ...orgOnly)),
    db
      .select({ runId: runs.id, poolId: routes.poolId, routeId: routes.id, startedAt: runs.startedAt })
      .from(runs)
      .innerJoin(routes, eq(routes.id, runs.routeId))
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .where(and(isNull(runs.endedAt), ...orgOnly)),
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
    })),
  ].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime() || byId(a.runId, b.runId));
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
      /** 三段的一次性会话：哪一段。按哪个用途算战绩由选路那边定（engine 的 SEGMENT_STAGE：动手按写码、验收按审查）。 */
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
