// 账号池上还没结束的会话：Fusion 的会话（session_runs）和三段的一次性会话（runs）并起来，各自经路由连到池。选路数池的并发
// （quota.ts 的 inFlightByPool，候选路由和额度表都用它）、切号前数带组织类型的池上还开着的会话（session-org.ts 的 openOrgRuns）
// 都读这一份：哪些行算还开着、怎么连到池只写在这里。各写各的就会一处数得着、一处数不着（#735：选路只数了 session_runs，
// 三段的会话不占池的名额，拼车池会被派超）。
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { pools, routes, runs, sessionRuns } from '../schema/index.ts';

/** 账号池上还没结束的一次会话。 */
export interface OpenPoolRun {
  runId: string;
  poolId: string;
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
 * 哪张表读不了都照常抛：数不全就不知道池满没满，当成没人在跑会把池派超。
 */
export async function openPoolRuns(db: Db, options: { orgPoolsOnly?: boolean } = {}): Promise<OpenPoolRun[]> {
  const orgOnly = options.orgPoolsOnly ? [isNotNull(pools.orgKind)] : [];
  const [sessions, oneShots] = await Promise.all([
    db
      .select({
        runId: sessionRuns.id,
        poolId: routes.poolId,
        queuedAt: sessionRuns.queuedAt,
        startedAt: sessionRuns.startedAt,
      })
      .from(sessionRuns)
      .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .where(and(isNull(sessionRuns.endedAt), ...orgOnly)),
    db
      .select({ runId: runs.id, poolId: routes.poolId, startedAt: runs.startedAt })
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
      kind: 'oneShot' as const,
      queuedAt: r.startedAt,
      startedAt: r.startedAt,
    })),
  ].sort(
    (a, b) =>
      a.queuedAt.getTime() - b.queuedAt.getTime() || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
  );
}
