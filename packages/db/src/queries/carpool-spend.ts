// 拼车池（带组织类型 carpool 的池）的两样事实（#194 方案 4.7）：
// 1. 并发上限：库里各个拼车池的 max_concurrency（选路、预占数的就是它，pool-runs.ts），引擎起来时拿它和登记的数核（engine 的 real/carpool-cap.ts）；
// 2. 一个窗口里本机记到的花费：驾驶舱额度页拿它和接口说的已用美元对账（api 的 carpool-reconcile-view.ts）。
// 读不了照常抛，不拿空、0 冒充没事；花费没记到的会话单独数，不当成 0 美元。
import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { pools, routes, runs, sessionRuns } from '../schema/index.ts';

export interface CarpoolPoolCap {
  poolId: string;
  maxConcurrency: number;
}

/** 库里所有带组织类型 carpool 的池和它们的并发上限，按池编号排。一个都没有回空数组：由调用方当「没找到拼车池」报，不当成上限 0。 */
export async function carpoolPoolCaps(db: Db): Promise<CarpoolPoolCap[]> {
  const rows = await db
    .select({ poolId: pools.id, maxConcurrency: pools.maxConcurrency })
    .from(pools)
    .where(eq(pools.orgKind, 'carpool'));
  return rows.sort((a, b) => (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0));
}

export interface CarpoolWindowSpend {
  /** 窗口里开始了的拼车会话（两种会话都算）。 */
  sessions: number;
  /** 记到花费的会话的花费合计（美元）。 */
  recordedUsd: number;
  /** 记到了花费的会话数。 */
  recorded: number;
  /** 没记到花费（cost_usd 为空）的会话数：执行体没报、或被切号停下没来得及记。 */
  unrecorded: number;
  /** 其中被切号停下的（结局 org_switch）。 */
  unrecordedSwitchStopped: number;
}

/**
 * [since, until] 内开始的、跑在拼车池上的会话各自花了多少：Fusion 的会话只看开始了的，三段的一次性会话都算（和 poolRunUsage 同一个口径），
 * 没跑成的也算（它花过的就是用过的）。花费为空的单独数（unrecorded），合计里不含它们。
 */
export async function carpoolWindowSpend(
  db: Db,
  q: { since: Date; until: Date },
): Promise<CarpoolWindowSpend> {
  const [sessions, oneShots] = await Promise.all([
    db
      .select({ costUsd: sessionRuns.costUsd, outcome: sessionRuns.outcome })
      .from(sessionRuns)
      .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .where(
        and(
          eq(pools.orgKind, 'carpool'),
          isNotNull(sessionRuns.startedAt),
          gte(sessionRuns.startedAt, q.since),
          lte(sessionRuns.startedAt, q.until),
        ),
      ),
    db
      .select({ costUsd: runs.costUsd, outcome: runs.outcome })
      .from(runs)
      .innerJoin(routes, eq(routes.id, runs.routeId))
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .where(and(eq(pools.orgKind, 'carpool'), gte(runs.startedAt, q.since), lte(runs.startedAt, q.until))),
  ]);
  const out: CarpoolWindowSpend = {
    sessions: 0,
    recordedUsd: 0,
    recorded: 0,
    unrecorded: 0,
    unrecordedSwitchStopped: 0,
  };
  for (const r of [...sessions, ...oneShots]) {
    out.sessions += 1;
    if (r.costUsd === null) {
      out.unrecorded += 1;
      if (r.outcome === 'org_switch') out.unrecordedSwitchStopped += 1;
    } else {
      out.recorded += 1;
      out.recordedUsd += r.costUsd;
    }
  }
  return out;
}
