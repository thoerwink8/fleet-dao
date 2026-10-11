// 渠道运行中失败（channel_states，#1118）：干活那边撞上了、被标不可用的渠道，为什么、顺延到谁、探针下次什么时候再看。
// 渠道卡怎么并、怎么排在 channel-status.ts（buildChannelCards 用这里的 failoverOf），这里只管这一块。
//
// 原来这里还有一份「近 60 次柱条」：把同一个渠道下几条路由的最近一次结论铺成 60 格，看着像历史其实不是。
// 真历史在渠道状态页，按 route_probe_history 一次一格画（#1139）。

import { probeNextEveryMinutes, ROUTE_PROBE_EVERY_MINUTES } from '@fleet-dao/shared';
import type { Channel, ChannelState, Model, Route } from '../api/types';

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
   * 探针下一次大约几点再看引发失败的那条路由：上次通了的按钟一轮（15 分钟；#1798 片 3 起不分执行方式，
   * 活跃 60 / 不活跃每天由引擎写 probe_next_at，片 7 再读）；不通且写了连着几次的按退避那一档，没写次数的仍按每轮。
   * 算不出（那条路由没探过 / 已被删）为 undefined，页面写「下一轮探针」。
   */
  nextProbeAt: string | undefined;
  /** 探针每隔多久一轮（分钟），给页面解释用。 */
  probeEveryMinutes: number;
}

export function failoverOf(
  state: ChannelState | undefined,
  routes: readonly Route[],
  routing: { channels: readonly Channel[]; models: readonly Model[] },
): Failover | undefined {
  if (state?.status !== 'disabled') return undefined;
  const failed = state.failedRouteId ? routes.find((r) => r.id === state.failedRouteId) : undefined;
  const everyMin = failed
    ? probeNextEveryMinutes(failed.hostId, failed.probe?.state, failed.probe?.detail)
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
