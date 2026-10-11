// 候选路由的判法：给一串排好的路由逐条写明它为什么不能用（被挡的不删，带原因留在表里）。用的人是路由两层的读法
// （routing-layers.ts：选路、驾驶舱都经它），「接得上、额度够、没被禁令挡」只有这一处判法。
import { hardBanFor, poolFull, type StageKind, windowAppliesTo } from '@fleet-dao/shared';
import { asc, inArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { bans, type channels, type models, type pools, quotaWindows, type routes } from '../schema/index.ts';
import { readChannelStates } from './channel-fallback.ts';
import { poolDataTimes, poolOccupancy, quotaReadOverdue, type WindowState, windowState } from './quota.ts';

/**
 * switched-off 这条路由在它的模型下关着（路由两层的开关，不分用途）；offline 探针或熔断判不在线；channel-disabled 渠道关了；channel-failed 渠道运行中失败、被标成 disabled 顺延给下一个渠道（channel_states，探针探通改回）；pool-expired 订阅过期；
 * model-retired 模型已下架；banned 命中禁令（代码里的全局硬禁令 + 库里的 bans）；quota-exhausted 适用的额度窗用满；
 * no-slot 账号池并发满了（等空位，不是坏了）。
 * 额度没读成不算挡：照常可选，但排在读到了的后面（设计 §九 选路第 3 条）。
 */
export type Blocker =
  | 'switched-off'
  | 'offline'
  | 'channel-disabled'
  | 'channel-failed'
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
  /** yes = 扣这条路由；unknown = 判不了（池给了成员表，路由没填上游名字），按额度未知算，不挡。 */
  applies: 'yes' | 'unknown';
  resetsAt: Date | null;
  readAt: Date;
  /** 非空 = 上游这次没报：只有最后一次读到是用满、还没过清零时刻的才列在这里，照样挡。 */
  staleSince: Date | null;
}

export interface RouteCandidate {
  routeId: string;
  /** 在它那一串里排的位置（路由两层里是模型下路由的位置，routing_catalog.position）。 */
  position: number;
  channelId: string;
  poolId: string;
  modelId: string;
  family: string;
  hostId: (typeof routes.$inferSelect)['hostId'];
  /**
   * 路由探针最近一次下结论的时刻（routes.probed_at），探针还没看过为空。在线的一定有（库里约束 alive 要有探针的 ok 结论）；
   * 结论过没过期由选路按现在的时刻判（引擎 routing/choose.ts），这里原样给。
   */
  probedAt: Date | null;
  /** 那次结论是什么（routes.probe_state）；探针还没看过为空。 */
  probeState: (typeof routes.$inferSelect)['probeState'];
  /** 探针自己写的原因（routes.probe_detail）：不是 ok 的结论一定有（库里约束），为什么没探、没通照它说。 */
  probeDetail: (typeof routes.$inferSelect)['probeDetail'];
  /**
   * Claude 订阅池的路由：探针下那次结论时会话用户挂的是哪个组织（routes.probe_org）。skipped、又是另一个组织 = 那一轮
   * 没探它，不是它坏了（引擎 routing/filter.ts 按它判等不等下一轮探针）。
   */
  probeOrg: (typeof routes.$inferSelect)['probeOrg'];
  /** 节奏档（#1798 片 6）：routes.probe_tier。空 = 还没写过。 */
  probeTier: (typeof routes.$inferSelect)['probeTier'];
  /** 下次定时探的时刻；不在用或还没写过为空。 */
  probeNextAt: (typeof routes.$inferSelect)['probeNextAt'];
  /** 连着不通几次。和档一起读出；接口侧老行不拿默认 0 顶。 */
  probeFailStreak: (typeof routes.$inferSelect)['probeFailStreak'];
  /** 上一次真探是 ping 还是 identity；空 = 还没写过。 */
  probeKind: (typeof routes.$inferSelect)['probeKind'];
  /**
   * unknown = 额度没读成或判不了：这个池从没读成过、最近一次读成或上游数据本身超过 30 分钟、适用的窗口已过清零点，
   * 或有窗口判不了扣不扣这条路由。派工原因里要写明「额度未知」。读成了、但没有扣这个模型的窗口，是 ok。
   */
  quota: 'ok' | 'exhausted' | 'unknown';
  /**
   * 这条路由适用（或判不了）的窗口：账号级的，加上扣本模型的模型组窗口（按 shared 的 windowAppliesTo 和池的成员表判）。
   * 上游这次没报的窗口（stale_since 非空）不挡路由、不参与排序；但最后一次读到是用满、还没过清零时刻的照样挡
   * （不知道清零时刻的，按读数 30 分钟内算），过了清零时刻才放。
   */
  windows: CandidateWindow[];
  /** 池上已开工、没结束的会话数；加上 reserved 到上限就挡 no-slot。 */
  inFlight: number;
  /**
   * 池上选定了还没开工的（Fusion 排着的、三段的一段占着名额的，#757）：和 inFlight 同一次读出来。no-slot 按两者之和判
   * （shared 的 poolFull，引擎选路、驾驶舱路由页同一个判法）。
   */
  reserved: number;
  maxConcurrency: number;
  /** 命中的禁令原因。 */
  banReasons: string[];
  blockers: Blocker[];
  /** blockers 为空。 */
  eligible: boolean;
}

/** 一条路由在某个顺序里的位置和开关（路由两层里模型下的路由顺序，routing_catalog）加上它连着的行。 */
export interface OrderedRouteRow {
  order: { position: number; enabled: boolean };
  route: typeof routes.$inferSelect;
  pool: typeof pools.$inferSelect;
  channel: typeof channels.$inferSelect;
  model: typeof models.$inferSelect;
}

/**
 * 给每一行判「为什么不能用」（blockers）和额度状态。路由两层（routing-layers.ts）的每一层都靠这一份：
 * 「接得上、额度够、没被禁令挡」只有一处判法，各处再写一遍就会各过各的。stage 只用来判禁令（硬禁令、bans 表里按阶段的）。
 * 不排序、不丢行：返回顺序同入参。额度没读成不挡，只标 unknown：排不排后面由选路判（引擎 routing/rank.ts）。
 */
export async function evaluateRoutes(
  db: Db,
  stage: StageKind,
  rows: readonly OrderedRouteRow[],
  options: { now: Date; staleAfterMs: number },
): Promise<RouteCandidate[]> {
  const { now, staleAfterMs } = options;
  const poolIds = [...new Set(rows.map((r) => r.pool.id))];
  const windowRows = await db
    .select()
    .from(quotaWindows)
    .where(inArray(quotaWindows.poolId, poolIds))
    .orderBy(asc(quotaWindows.label));
  const dataTimes = poolDataTimes(windowRows);
  const dbBans = await db.select().from(bans);
  const occupancy = await poolOccupancy(db, { now });
  // 渠道近态（#1118）：读不到抛出去（选路因此派不出去、报人），不当成全 ok；没有行的渠道没出过事
  const channelStateById = await readChannelStates(db, [...new Set(rows.map((r) => r.channel.id))]);

  return rows.map(({ order, route, pool, channel, model }): RouteCandidate => {
    // 成员表只和路由在上游的名字比（实际发的模型串 + 别名），不拿模型目录的 id 硬凑。
    const ref = {
      id: model.id,
      family: model.family,
      upstreamNames: [...(route.upstreamModel ? [route.upstreamModel] : []), ...route.upstreamAliases],
    };
    const windows: CandidateWindow[] = [];
    for (const w of windowRows) {
      if (w.poolId !== pool.id) continue;
      const applies = windowAppliesTo(w, ref, pool.scopeModels ?? undefined);
      if (applies === 'no') continue;
      const state = windowState(w, now, staleAfterMs);
      if (w.staleSince !== null && state !== 'exhausted') continue;
      windows.push({
        label: w.label,
        window: w.window,
        scope: w.scope === '' ? null : w.scope,
        state,
        applies,
        resetsAt: w.resetsAt,
        readAt: w.readAt,
        staleSince: w.staleSince,
      });
    }
    const readFresh = !quotaReadOverdue(
      { lastReadOkAt: pool.lastReadOkAt, dataAt: dataTimes.get(pool.id) ?? null },
      now,
      staleAfterMs,
    );
    const quota = windows.some((w) => w.applies === 'yes' && w.state === 'exhausted')
      ? 'exhausted'
      : readFresh && windows.every((w) => w.applies === 'yes' && w.state === 'ok')
        ? 'ok'
        : 'unknown';

    // 代码里的硬禁令先过（库里的表清空了也照样生效），再并上库里的：写了的每一项都要对上才算命中，没写阶段 = 所有阶段。
    const hardBan = hardBanFor(
      { ...model, upstreamModel: route.upstreamModel, upstreamAliases: route.upstreamAliases },
      stage,
    );
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

    const running = occupancy.get(pool.id)?.inFlight ?? 0;
    const reserved = occupancy.get(pool.id)?.reserved ?? 0;
    const blockers: Blocker[] = [];
    if (!order.enabled) blockers.push('switched-off');
    // 按需探测（on_demand）的路由 alive 留 false，但不挡：派前探一次，探通才派（#1635）
    if (!route.alive && route.probeState !== 'on_demand') blockers.push('offline');
    if (!channel.enabled) blockers.push('channel-disabled');
    if (channelStateById.get(channel.id)?.status === 'disabled') blockers.push('channel-failed');
    if (pool.expiresAt !== null && pool.expiresAt.getTime() <= now.getTime()) blockers.push('pool-expired');
    if (model.retiredAt !== null && model.retiredAt.getTime() <= now.getTime())
      blockers.push('model-retired');
    if (banReasons.length > 0) blockers.push('banned');
    if (quota === 'exhausted') blockers.push('quota-exhausted');
    // 满不满只有 shared 的 poolFull 一个判法：在跑的 + 已选定还没开工的（#757 预占、#800），引擎选路、驾驶舱同一个
    if (poolFull({ inFlight: running, reserved, maxConcurrency: pool.maxConcurrency }))
      blockers.push('no-slot');

    return {
      routeId: route.id,
      position: order.position,
      channelId: channel.id,
      poolId: pool.id,
      modelId: model.id,
      family: model.family,
      hostId: route.hostId,
      probedAt: route.probedAt,
      probeState: route.probeState,
      probeDetail: route.probeDetail,
      probeOrg: route.probeOrg,
      probeTier: route.probeTier,
      probeNextAt: route.probeNextAt,
      probeFailStreak: route.probeFailStreak,
      probeKind: route.probeKind,
      quota,
      windows,
      inFlight: running,
      reserved,
      maxConcurrency: pool.maxConcurrency,
      banReasons,
      blockers,
      eligible: blockers.length === 0,
    };
  });
}
