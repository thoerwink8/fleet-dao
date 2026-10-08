// 路由探针（design 第九节「路由探针」）：读每条路由探得了探不了的事实，写一条路由的结论。
// routes.alive 只由探针和熔断写：这里是探针那一半。库里约束 alive 为真时结论必须是 ok，不许拿默认值、手改冒充在线。
import type { BillingKind, HostId, OrgKind, RouteProbeState } from '@fleet-dao/shared';
import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { routesInUse } from '../routing-layers.ts';
import {
  channels,
  models,
  pools,
  type RouteProbeHistoryResult,
  routeProbeHistory,
  routes,
} from '../schema/index.ts';
import { noteRouteProbed } from './channel-fallback.ts';

/** 每条路由留下的历史条数：和渠道状态页一条条带的格数是同一个数（shared 的 PROBE_HISTORY_SLOTS）。 */
export const ROUTE_PROBE_HISTORY_KEEP = PROBE_HISTORY_SLOTS;

/** 「用时 N 秒」：老结论只写在 probe_detail 里，回填时把它还原成毫秒。认不出、装不进整数列就空着。 */
const LATENCY_SEC = /用时\s*(\d+)\s*秒/;
const DURATION_MS_MAX = 2_147_483_647;

export function durationMsFromProbeDetail(detail: string | null): number | null {
  if (!detail) return null;
  const matched = LATENCY_SEC.exec(detail);
  if (!matched?.[1]) return null;
  const seconds = Number(matched[1]);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  const ms = seconds * 1000;
  if (ms > DURATION_MS_MAX) return null;
  return ms;
}
/** 请求原文、响应原文、失败原因的长度上限。超了截断，并在末尾标明原文多长。 */
export const ROUTE_PROBE_HISTORY_TEXT_MAX = 4_000;

export interface RouteProbeTarget {
  routeId: string;
  hostId: HostId;
  channelId: string;
  channelName: string;
  billing: BillingKind;
  channelEnabled: boolean;
  poolId: string;
  /** 这个池的会话跑在哪个系统用户下（pools.run_as_user）；空 = 还没定。 */
  runAsUser: string | null;
  /** Claude 订阅池对应的组织类型（pools.org_kind）：会话用户挂着别的组织时探它扣的是别的池。 */
  orgKind: OrgKind | null;
  modelId: string;
  modelName: string;
  /** 插头实际发给上游的模型串（routes.upstream_model）；空 = 按模型目录的 id。 */
  upstreamModel: string | null;
  modelRetiredAt: Date | null;
  /**
   * 有用途在用（路由两层：它在自己的模型下开着，这个模型又排进了至少一个用途，routing-layers.ts 的 routesInUse）：
   * 选路派不到的路由不花额度去探。
   */
  inUse: boolean;
  alive: boolean;
  /** 上一次的结论；探针还没看过为空。 */
  previous: { state: RouteProbeState; at: Date; detail: string | null } | null;
}

/** 全部路由，按 id 排。连不上库、查询出错原样抛出（这一轮没跑成，由调用方记 failed）。 */
export async function routeProbeTargets(db: Db): Promise<RouteProbeTarget[]> {
  const [rows, used] = await Promise.all([
    db
      .select({ route: routes, pool: pools, channel: channels, model: models })
      .from(routes)
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .innerJoin(channels, eq(channels.id, routes.channelId))
      .innerJoin(models, eq(models.id, routes.modelId))
      .orderBy(asc(routes.id)),
    routesInUse(db),
  ]);
  const inUse = new Set(used.map((u) => u.routeId));
  return rows.map(({ route, pool, channel, model }) => ({
    routeId: route.id,
    hostId: route.hostId,
    channelId: channel.id,
    channelName: channel.name,
    billing: channel.billing,
    channelEnabled: channel.enabled,
    poolId: pool.id,
    runAsUser: pool.runAsUser,
    orgKind: pool.orgKind,
    modelId: model.id,
    modelName: model.displayName,
    upstreamModel: route.upstreamModel,
    modelRetiredAt: model.retiredAt,
    inUse: inUse.has(route.id),
    alive: route.alive,
    previous:
      route.probeState === null || route.probedAt === null
        ? null
        : { state: route.probeState, at: route.probedAt, detail: route.probeDetail },
  }));
}

export interface RouteProbeWrite {
  routeId: string;
  state: RouteProbeState;
  /** 下这个结论的时刻。 */
  at: Date;
  /** 不是 ok 必须写原因（库里约束）；ok 也带一句。 */
  detail: string;
  /**
   * Claude 订阅池的路由：下这个结论时会话用户挂的是哪个组织（routes.probe_org）；读不到、不是 Claude 订阅池给 null。
   * 不给按 null 写（老的调用方）：不留上一次的，免得这个结论配上别的时候读到的组织。
   */
  org?: OrgKind | null;
  /**
   * 这一次真探的耗时（毫秒）。没探、探针没量到，不给或给 null：历史里写空，不当 0。
   * 0 是量到了、用时不到 1 毫秒，照记。
   */
  durationMs?: number | null;
  /** 发出去的请求原文。没发出去不给或给 null。超长截断并标注。 */
  requestText?: string | null;
  /** 响应原文。没拿到不给或给 null。超长截断并标注。 */
  responseText?: string | null;
}

export interface RouteProbeHistoryRow {
  id: number;
  routeId: string;
  probedAt: Date;
  result: RouteProbeHistoryResult;
  durationMs: number | null;
  failureReason: string | null;
  requestText: string | null;
  responseText: string | null;
}

/** ok → 通过；failed → 不通；not_wired、skipped → 没探（这一轮没真探）。 */
function historyResultOf(state: RouteProbeState): RouteProbeHistoryResult {
  if (state === 'ok') return 'passed';
  if (state === 'failed') return 'failed';
  return 'not_probed';
}

function clipProbeText(text: string): string {
  if (text.length <= ROUTE_PROBE_HISTORY_TEXT_MAX) return text;
  const mark = `…（已截断，原文 ${text.length} 字）`;
  const keep = Math.max(0, ROUTE_PROBE_HISTORY_TEXT_MAX - mark.length);
  return `${text.slice(0, keep)}${mark}`;
}

function clipOrNull(text: string | null | undefined): string | null {
  if (text == null) return null;
  return clipProbeText(text);
}

/**
 * 写一条路由的结论：只有 ok 让它在线，其余一律不在线（alive、结论、那时挂的组织在同一条语句里写，不会一半）。
 * 同一事务里追加一条历史，并把这条路由多出来的旧历史裁到最近 60 条。路由更新、历史、渠道近态一起成功或一起退回。
 * 路由已经不在了（这一轮当中被删）回 route_not_found，不写历史；别的出错（约束不让写、库连不上）原样抛出。
 */
export async function saveRouteProbe(db: Db, w: RouteProbeWrite): Promise<'saved' | 'route_not_found'> {
  const result = historyResultOf(w.state);
  // 渠道近态（channel_states，#1118）跟着同一个事务：探通了引发 disabled 的那条路由就改回 ok，探针看过的时刻记下
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(routes)
      .set({
        alive: w.state === 'ok',
        probeState: w.state,
        probedAt: w.at,
        probeDetail: w.detail,
        probeOrg: w.org ?? null,
      })
      .where(eq(routes.id, w.routeId))
      .returning({ id: routes.id });
    if (updated.length === 0) return 'route_not_found';
    await tx.insert(routeProbeHistory).values({
      routeId: w.routeId,
      probedAt: w.at,
      result,
      durationMs: w.durationMs ?? null,
      // 通过没有失败原因。不通、没探用这条结论的原因；超长同样截断。
      failureReason: result === 'passed' ? null : clipProbeText(w.detail),
      requestText: clipOrNull(w.requestText),
      responseText: clipOrNull(w.responseText),
    });
    await tx.execute(sql`
      delete from route_probe_history
      where route_id = ${w.routeId}
        and id not in (
          select id from route_probe_history
          where route_id = ${w.routeId}
          order by probed_at desc, id desc
          limit ${ROUTE_PROBE_HISTORY_KEEP}
        )
    `);
    await noteRouteProbed(tx, { routeId: w.routeId, state: w.state, at: w.at });
    return 'saved';
  });
}

export interface ProbeHistoryJoined {
  id: number;
  routeId: string;
  channelId: string;
  probedAt: Date;
  result: RouteProbeHistoryResult;
  durationMs: number | null;
  failureReason: string | null;
  requestText: string | null;
  responseText: string | null;
}

/**
 * 老结论还没进历史表时补一条（路由上的 probe_state / probed_at / probe_detail）。
 * 已经有历史的路由不动。耗时只从「用时 N 秒」还原，请求和响应原文老列里没有，写空。
 * 同一事务里加锁，免得两个人同时打开页面各补一条。回补了几条。
 */
export async function backfillProbeHistoryFromRoutes(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(11391312)`);
    const have = await tx.selectDistinct({ routeId: routeProbeHistory.routeId }).from(routeProbeHistory);
    const known = new Set(have.map((row) => row.routeId));
    const listed = await tx
      .select({
        id: routes.id,
        probeState: routes.probeState,
        probedAt: routes.probedAt,
        probeDetail: routes.probeDetail,
      })
      .from(routes);
    const missing = listed.filter(
      (row): row is typeof row & { probeState: RouteProbeState; probedAt: Date } =>
        row.probeState !== null && row.probedAt !== null && !known.has(row.id),
    );
    if (missing.length === 0) return 0;
    await tx.insert(routeProbeHistory).values(
      missing.map((row) => {
        const result = historyResultOf(row.probeState);
        const detail = row.probeDetail?.trim() ? clipProbeText(row.probeDetail) : '';
        return {
          routeId: row.id,
          probedAt: row.probedAt,
          result,
          durationMs: durationMsFromProbeDetail(row.probeDetail),
          // 通过没有失败原因。不通、没探沿用老结论的原文；空的写一句，免得整批回填被约束打回。
          failureReason: result === 'passed' ? null : detail || '（回填时这条老结论没有原因）',
          requestText: null,
          responseText: null,
        };
      }),
    );
    return missing.length;
  });
}

/**
 * 还在的路由的全部探针历史，旧的在前（同一时刻先写入的在前），带上渠道。
 * 路由已经删了的历史不在这里：页面按渠道画，删了的路由归不到渠道上。
 * 一条都没有：回空数组（还没写下过结论，也没有能回填的老结论）。
 * 库读不到：抛错，不回空数组冒充没有历史。
 */
export async function readProbeHistoryJoined(db: Db): Promise<ProbeHistoryJoined[]> {
  try {
    return await db
      .select({
        id: routeProbeHistory.id,
        routeId: routeProbeHistory.routeId,
        channelId: routes.channelId,
        probedAt: routeProbeHistory.probedAt,
        result: routeProbeHistory.result,
        durationMs: routeProbeHistory.durationMs,
        failureReason: routeProbeHistory.failureReason,
        requestText: routeProbeHistory.requestText,
        responseText: routeProbeHistory.responseText,
      })
      .from(routeProbeHistory)
      .innerJoin(routes, eq(routes.id, routeProbeHistory.routeId))
      .orderBy(asc(routeProbeHistory.probedAt), asc(routeProbeHistory.id));
  } catch (err) {
    throw new Error(`读不到探针历史（route_probe_history）：${errMessage(err)}`, { cause: err });
  }
}

/**
 * 一条路由最近的历史，新的在前（同一时刻后写入的在前）。条数必须是正整数。
 * 查询成功但一条都没有：回空数组（这条路由还没写下过结论）。
 * 库读不到（连不上、表不在、语句出错）：抛错，说明是哪条路由，不回空数组冒充没有历史。
 */
export async function readRouteProbeHistory(
  db: Db,
  routeId: string,
  limit: number,
): Promise<RouteProbeHistoryRow[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`读探针历史的条数必须是正整数，收到 ${String(limit)}`);
  }
  try {
    const rows = await db
      .select({
        id: routeProbeHistory.id,
        routeId: routeProbeHistory.routeId,
        probedAt: routeProbeHistory.probedAt,
        result: routeProbeHistory.result,
        durationMs: routeProbeHistory.durationMs,
        failureReason: routeProbeHistory.failureReason,
        requestText: routeProbeHistory.requestText,
        responseText: routeProbeHistory.responseText,
      })
      .from(routeProbeHistory)
      .where(eq(routeProbeHistory.routeId, routeId))
      .orderBy(desc(routeProbeHistory.probedAt), desc(routeProbeHistory.id))
      .limit(limit);
    return rows;
  } catch (err) {
    throw new Error(`读不到路由 ${routeId} 的探针历史（route_probe_history）：${errMessage(err)}`, {
      cause: err,
    });
  }
}
