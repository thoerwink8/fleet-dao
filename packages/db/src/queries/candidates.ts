// 某阶段的候选路由：列出该阶段挂的每一条路由，并写明它为什么不能用（被挡的不删，带原因留在表里）。
import { hardBanFor, type StageKind, windowAppliesTo } from '@fleet-dao/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  bans,
  channels,
  models,
  pools,
  quotaWindows,
  routes,
  stagePolicies,
  stagePolicyRoutes,
} from '../schema/index.ts';
import {
  inFlightByPool,
  QUOTA_STALE_AFTER_MS,
  quotaReadOverdue,
  type WindowState,
  windowState,
} from './quota.ts';

/**
 * offline 探针或熔断判不在线；channel-disabled 渠道关了；pool-expired 订阅过期；model-retired 模型已下架；
 * banned 命中禁令（代码里的全局硬禁令 + 库里的 bans）；quota-exhausted 适用的额度窗用满；
 * no-slot 账号池并发满了（等空位，不是坏了）。
 * 额度没读成不算挡：照常可选，但排在读到了的后面（设计 §九 选路第 3 条）。
 */
export type Blocker =
  | 'offline'
  | 'channel-disabled'
  | 'pool-expired'
  | 'model-retired'
  | 'banned'
  | 'quota-exhausted'
  | 'no-slot';

export interface CandidateWindow {
  label: string;
  window: (typeof quotaWindows.$inferSelect)['window'];
  scope: string | null;
  state: WindowState;
  resetsAt: Date | null;
  readAt: Date;
}

export interface RouteCandidate {
  routeId: string;
  /** 调度台上排的位置。 */
  position: number;
  channelId: string;
  poolId: string;
  modelId: string;
  family: string;
  hostId: (typeof routes.$inferSelect)['hostId'];
  /**
   * unknown = 额度没读成：这个池从没读成过、最近一次读成超过 30 分钟，或适用的窗口已过清零点。派工原因里要写明「额度未知」。
   * 读成了、但没有扣这个模型的窗口，是 ok。
   */
  quota: 'ok' | 'exhausted' | 'unknown';
  /**
   * 这条路由适用的窗口：账号级的，加上扣本模型的模型组窗口（按 shared 的 windowAppliesTo 和池的成员表判）。
   * 上游这次没报的窗口（stale_since 非空）不算：不挡路由，也不参与排序。
   */
  windows: CandidateWindow[];
  inFlight: number;
  maxConcurrency: number;
  /** 命中的禁令原因。 */
  banReasons: string[];
  blockers: Blocker[];
  /** blockers 为空。 */
  eligible: boolean;
}

export interface StageCandidates {
  stage: StageKind;
  /** 这个阶段还没配顺序（没有 stage_policies 行）时为 false；此时候选为空，不按 id 顺序乱挑。 */
  configured: boolean;
  pinned: boolean;
  /** 数组顺序就是实际先后：调度台的顺序，额度没读成的整体挪到读到了的后面。 */
  candidates: RouteCandidate[];
}

export interface StageCandidatesOptions {
  now?: Date;
  staleAfterMs?: number;
}

export async function stageCandidates(
  db: Db,
  stage: StageKind,
  options: StageCandidatesOptions = {},
): Promise<StageCandidates> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? QUOTA_STALE_AFTER_MS;

  const [policy] = await db.select().from(stagePolicies).where(eq(stagePolicies.stage, stage));
  if (!policy) return { stage, configured: false, pinned: false, candidates: [] };

  const rows = await db
    .select({ order: stagePolicyRoutes, route: routes, pool: pools, channel: channels, model: models })
    .from(stagePolicyRoutes)
    .innerJoin(routes, eq(routes.id, stagePolicyRoutes.routeId))
    .innerJoin(pools, eq(pools.id, routes.poolId))
    .innerJoin(channels, eq(channels.id, routes.channelId))
    .innerJoin(models, eq(models.id, routes.modelId))
    .where(eq(stagePolicyRoutes.stage, stage))
    .orderBy(asc(stagePolicyRoutes.position));
  if (rows.length === 0) return { stage, configured: true, pinned: policy.pinned, candidates: [] };

  const poolIds = [...new Set(rows.map((r) => r.pool.id))];
  const windowRows = await db.select().from(quotaWindows).where(inArray(quotaWindows.poolId, poolIds));
  const dbBans = await db.select().from(bans);
  const inFlight = await inFlightByPool(db);

  const candidates = rows.map(({ order, route, pool, channel, model }): RouteCandidate => {
    const windows: CandidateWindow[] = windowRows
      .filter(
        (w) =>
          w.poolId === pool.id &&
          w.staleSince === null &&
          windowAppliesTo(w, model, pool.scopeModels ?? undefined),
      )
      .map((w) => ({
        label: w.label,
        window: w.window,
        scope: w.scope === '' ? null : w.scope,
        state: windowState(w, now, staleAfterMs),
        resetsAt: w.resetsAt,
        readAt: w.readAt,
      }));
    const readFresh = !quotaReadOverdue(pool.lastReadOkAt, now, staleAfterMs);
    const quota = windows.some((w) => w.state === 'exhausted')
      ? 'exhausted'
      : readFresh && windows.every((w) => w.state === 'ok')
        ? 'ok'
        : 'unknown';

    // 代码里的硬禁令先过（库里的表清空了也照样生效），再并上库里的：写了的每一项都要对上才算命中，没写阶段 = 所有阶段。
    const hardBan = hardBanFor(model, stage);
    const banReasons = [
      ...(hardBan ? [hardBan.reason] : []),
      ...dbBans
        .filter(
          (b) =>
            (b.stage === null || b.stage === stage) &&
            (b.family === null || b.family === model.family) &&
            (b.modelId === null || b.modelId === model.id),
        )
        .map((b) => b.reason),
    ];

    const running = inFlight.get(pool.id) ?? 0;
    const blockers: Blocker[] = [];
    if (!route.alive) blockers.push('offline');
    if (!channel.enabled) blockers.push('channel-disabled');
    if (pool.expiresAt !== null && pool.expiresAt.getTime() <= now.getTime()) blockers.push('pool-expired');
    if (model.retiredAt !== null && model.retiredAt.getTime() <= now.getTime())
      blockers.push('model-retired');
    if (banReasons.length > 0) blockers.push('banned');
    if (quota === 'exhausted') blockers.push('quota-exhausted');
    if (running >= pool.maxConcurrency) blockers.push('no-slot');

    return {
      routeId: route.id,
      position: order.position,
      channelId: channel.id,
      poolId: pool.id,
      modelId: model.id,
      family: model.family,
      hostId: route.hostId,
      quota,
      windows,
      inFlight: running,
      maxConcurrency: pool.maxConcurrency,
      banReasons,
      blockers,
      eligible: blockers.length === 0,
    };
  });
  // 稳定排序：额度没读成的整体往后挪，两段里各自保持调度台的顺序。
  candidates.sort((a, b) => Number(a.quota === 'unknown') - Number(b.quota === 'unknown'));

  return { stage, configured: true, pinned: policy.pinned, candidates };
}
