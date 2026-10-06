// 渠道状态页「按供应商聚合」（#1087，路由两层页左边的卡）：每个渠道一张卡——近 60 次健康结果柱条、
// 平均耗时、可用率、当前状态。
//
// 为什么不读真历史：库里 routes 只存探针最近一次结论（probe_state / probed_at / probe_detail），
// 没有逐条历史表（那是另一张单）。这里的「近 60 次」是把同一个渠道下几条路由的最近一次结论按
// 表里出现的先后铺成 60 格，每一格还是真结论；真历史接入后换成真历史，形状不变。
// mock（演示版）仍然走的是同一个函数：它从同一份 routing/routingLayers 拿到渠道和路由。

import { ROUTE_PROBE_EVERY_MINUTES, routeProbeEveryMinutes } from '@fleet-dao/shared';
import type { Channel, ChannelState, Model, Route, RoutingLayers } from '../api/types';
import { probeLatency } from './channel-status';

/** 一张供应商卡里的一格：近 60 次中的一次。 */
export interface Tick {
  /** 这一次的颜色。ok 通；down 探针报错；off 没探过这个格（这个渠道不足 60 次）。 */
  kind: 'ok' | 'partial' | 'down' | 'off';
  /** 哪条路由、什么时刻的结论。 */
  routeId: string;
  at: string;
  /** 一句话（比如「答上了 OK · 用时 9 秒」）；没探到就写。 */
  text: string;
}

/**
 * 渠道运行中失败、被标成不可用（channel_states，#1118）：为什么、顺延到谁、探针下次什么时候再看。
 * 探通引发失败的那条路由之后渠道自己改回，这一块就没有了。
 */
export interface Failover {
  /** 为什么不可用（失败分流的原因，带上游原文摘要）。 */
  reason: string;
  /** 几点标上的。 */
  flaggedAt: string | undefined;
  /** 引发失败的那条路由（探针探通它渠道才恢复）；已被删了为 undefined。 */
  failedRouteId: string | undefined;
  /** 顺延到谁（渠道名和模型名）；还没派出去、或没有别的渠道可顺延为 undefined。 */
  fallback: { channelName: string; modelName: string } | undefined;
  /**
   * 探针下一次大约几点再看引发失败的那条路由：它最近一次结论的时刻加上这种执行方式的探测间隔（上次通了的按
   * 执行方式放慢的间隔，没通的每轮都探）。算不出（那条路由没探过 / 已被删）为 undefined，页面写「下一轮探针」。
   */
  nextProbeAt: string | undefined;
  /** 探针每隔多久一轮（分钟），给页面解释用。 */
  probeEveryMinutes: number;
}

/** 一张供应商卡：左卡那一块。 */
export interface ProviderCard {
  channel: Channel;
  /** 近 60 次的柱条，从旧到新；不足 60 次前面补 off。 */
  ticks: Tick[];
  /** 通了的有几次（用来算可用率）；可用率 = ok + (partial / 2)，纯百分比按 ok 算。 */
  okCount: number;
  downCount: number;
  probedCount: number;
  /** 可用率：0..1，没探任何一条时 undefined。 */
  availability: number | undefined;
  /** 平均耗时（秒）：从探过的那几条的「用时 N 秒」里平均；一条都没带到就 undefined。 */
  avgLatencySec: number | undefined;
  /** 当前状态：整个渠道最新一次结论的判法（ok / partial / down / unknown / off）。 */
  current:
    | { kind: 'ok'; label: string }
    | { kind: 'partial'; label: string; reason: string }
    | { kind: 'down'; label: string; reason: string }
    | { kind: 'unknown'; label: string; reason: string }
    | { kind: 'off'; label: string; reason: string };
  /** 这个渠道下挂在路由两层里的路由（拿来画右边的明细）。 */
  routes: Route[];
  /** 这个渠道在用吗（已下架 = 渠道自己 enabled 是 false）。 */
  enabled: boolean;
  /** 运行中失败被标不可用：为什么、顺延到谁、下次探测；没出过事或已恢复为 undefined。 */
  failover: Failover | undefined;
}

export const TICKS_PER_CARD = 60;

const LATENCY = /用时\s*(\d+)\s*秒/;

function latencySecOf(detail: string | undefined): number | undefined {
  const m = detail ? LATENCY.exec(detail) : null;
  const n = m?.[1];
  return n !== undefined ? Number.parseInt(n, 10) : undefined;
}

function tickKind(state: Route['probe'] | undefined): Tick['kind'] {
  if (!state) return 'off';
  if (state.state === 'ok') return 'ok';
  if (state.state === 'failed') return 'down';
  // skipped、未探等：写「还没探到」用 off；这里拿 partial 给看到 skipped 的卡一点颜色
  if (state.state === 'skipped') return 'partial';
  return 'off';
}

const OFF_TICK = (routeId: string): Tick => ({
  kind: 'off',
  routeId,
  at: '',
  text: '探针还没看过',
});

function tickOf(route: Route): Tick {
  if (!route.probe) return OFF_TICK(route.id);
  return {
    kind: tickKind(route.probe),
    routeId: route.id,
    at: route.probe.at,
    text: route.probe.detail ?? '',
  };
}

/** 卡的当前状态：从这个渠道几条路由的最新结论并起来。 */
function currentOf(routes: readonly Route[], channelEnabled: boolean): ProviderCard['current'] {
  if (!channelEnabled) {
    return { kind: 'off', label: '渠道已下架', reason: '目录里这个渠道已下架，选路不派它' };
  }
  if (routes.length === 0) {
    return {
      kind: 'unknown',
      label: '没配路由',
      reason: '这个渠道下一条路由都没有：排了它也派不到它',
    };
  }
  const probed = routes.filter((r) => r.probe);
  if (probed.length === 0) {
    return {
      kind: 'unknown',
      label: '还没探到',
      reason: '探针没看过这个渠道（探针停着、按量计费不探、或上线后第一轮还没到），最近一次结论没有',
    };
  }
  const ok = probed.filter((r) => r.probe?.state === 'ok');
  const failed = probed.filter((r) => r.probe?.state === 'failed');
  if (failed.length === 0 && ok.length > 0) {
    return { kind: 'ok', label: '正常' };
  }
  if (ok.length > 0) {
    const reason = failed[0]?.probe?.detail ?? '';
    return { kind: 'partial', label: '部分路不通', reason };
  }
  const reason = failed[0]?.probe?.detail ?? '';
  return { kind: 'down', label: '暂不可用', reason };
}

function failoverOf(
  state: ChannelState | undefined,
  routes: readonly Route[],
  routing: { channels: readonly Channel[]; models: readonly Model[] },
): Failover | undefined {
  if (state?.status !== 'disabled') return undefined;
  const failed = state.failedRouteId ? routes.find((r) => r.id === state.failedRouteId) : undefined;
  const everyMin = failed
    ? failed.probe?.state === 'ok'
      ? routeProbeEveryMinutes(failed.hostId)
      : ROUTE_PROBE_EVERY_MINUTES
    : ROUTE_PROBE_EVERY_MINUTES;
  const nextProbeAt = failed?.probe
    ? new Date(Date.parse(failed.probe.at) + everyMin * 60_000).toISOString()
    : undefined;
  const fallbackChannel = state.fallbackChannelId
    ? routing.channels.find((c) => c.id === state.fallbackChannelId)
    : undefined;
  const fallbackModel = state.fallbackModelId
    ? routing.models.find((m) => m.id === state.fallbackModelId)
    : undefined;
  return {
    reason: state.reason ?? '（库里没写原因）',
    flaggedAt: state.flaggedAt,
    failedRouteId: state.failedRouteId,
    fallback: state.fallbackChannelId
      ? {
          channelName: fallbackChannel?.name ?? state.fallbackChannelId,
          modelName: fallbackModel?.displayName ?? state.fallbackModelId ?? '',
        }
      : undefined,
    nextProbeAt,
    probeEveryMinutes: everyMin,
  };
}

/**
 * 每个渠道一张卡：近 60 次柱条（同一个渠道下几条路由的最近一次结论，最旧的在最左；
 * 不足 60 次前面用 off 补）、可用率（ok / 已探）、平均耗时（已探里 ok 的「用时 N 秒」平均）。
 */
export function buildProviderCards(
  routing: {
    channels: readonly Channel[];
    channelStates: readonly ChannelState[];
    routes: readonly Route[];
    models: readonly Model[];
  },
  _layers: RoutingLayers | undefined,
): ProviderCard[] {
  return routing.channels.map((channel): ProviderCard => {
    const mine = routing.routes
      .filter((r) => r.channelId === channel.id)
      // 按渠道目录里的先后；探过的在前没探过的在后，更直观
      .sort((a, b) => {
        const ap = a.probe ? 0 : 1;
        const bp = b.probe ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.id.localeCompare(b.id);
      });

    const probedTicks = mine.filter((r) => r.probe).map(tickOf);
    const okCount = probedTicks.filter((t) => t.kind === 'ok').length;
    const downCount = probedTicks.filter((t) => t.kind === 'down').length;
    const probedCount = probedTicks.length;
    const availability = probedCount === 0 ? undefined : okCount / probedCount;

    const latencies = mine
      .map((r) => latencySecOf(r.probe?.detail))
      .filter((n): n is number => n !== undefined);
    const avgLatencySec =
      latencies.length === 0 ? undefined : latencies.reduce((a, b) => a + b, 0) / latencies.length;

    // 近 60 次：真历史接入前，按渠道下几条路由的最近一次结论铺
    // （渠道有几条路由就有几格，剩下前面补「还没探到」的 off）。
    const ticks: Tick[] = [
      ...Array.from({ length: Math.max(0, TICKS_PER_CARD - mine.length) }, () => OFF_TICK('')),
      ...mine.map(tickOf),
    ];

    const failover = failoverOf(
      routing.channelStates.find((s) => s.channelId === channel.id),
      routing.routes,
      routing,
    );
    const current: ProviderCard['current'] = !channel.enabled
      ? currentOf(mine, false)
      : failover
        ? {
            kind: 'down',
            label: '运行中失败，已顺延',
            reason: failover.reason,
          }
        : currentOf(mine, true);

    return {
      channel,
      ticks,
      okCount,
      downCount,
      probedCount,
      availability,
      avgLatencySec,
      current,
      routes: mine,
      enabled: channel.enabled,
      failover: channel.enabled ? failover : undefined,
    };
  });
}

/** 顶部汇总「5 / 6 正常」那一句。ok 和 partial 都算「正常」；down 的算「不正常」。 */
export function summaryLine(cards: readonly ProviderCard[]): {
  ok: number;
  total: number;
  downNames: string[];
} {
  const open = cards.filter((c) => c.current.kind !== 'off');
  const bad = open.filter((c) => c.current.kind === 'down');
  return { ok: open.length - bad.length, total: open.length, downNames: bad.map((c) => c.channel.name) };
}
