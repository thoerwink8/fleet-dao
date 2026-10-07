// 渠道状态页的立即探测（驾驶舱改版 2026-10-07）：从「最近点过的立即探测」里找一条路由此刻在不在探、上一次立即探测给了它什么。
// 一次立即探测走到哪由后端现算（shared 的 foldRouteProbeRequests），这里只按路由挑出来，不再判一遍。

import type { Route, RouteProbeRequest, RouteProbeResult } from '../api/types';

const covers = (r: RouteProbeRequest, routeId: string) =>
  r.routeIds === undefined || r.routeIds.includes(routeId);

export const isActive = (r: RouteProbeRequest) => r.state === 'queued' || r.state === 'running';

/** 这条路由此刻在排队、在探的那一次（最新的）；没有就是没在探。 */
export function activeFor(
  requests: readonly RouteProbeRequest[],
  routeId: string,
): RouteProbeRequest | undefined {
  return requests.find((r) => isActive(r) && covers(r, routeId));
}

/** 这条路由最近一次立即探测的结论（新的在前，第一个有它的）；带上是哪一次。 */
export function lastResultFor(
  requests: readonly RouteProbeRequest[],
  routeId: string,
): { request: RouteProbeRequest; result: RouteProbeResult } | undefined {
  for (const request of requests) {
    if (request.state !== 'done') continue;
    const result = request.results.find((x) => x.routeId === routeId);
    if (result) return { request, result };
  }
  return undefined;
}

/** 这条路由最近一次立即探测没成（作废、引擎说没探成）：比路由上的结论新才算，旧的已经被后来的结论盖过了。 */
export function lastFailureFor(
  requests: readonly RouteProbeRequest[],
  route: Route,
): RouteProbeRequest | undefined {
  const r = requests.find((x) => !isActive(x) && covers(x, route.id));
  if (!r || (r.state !== 'failed' && r.state !== 'expired')) return undefined;
  if (route.probe && Date.parse(route.probe.at) >= Date.parse(r.requestedAt)) return undefined;
  return r;
}

const LATENCY = /用时\s*(\d+)\s*秒/;

/**
 * 这条路由最近一次结论用了多久（秒）：立即探测量到的（同一次结论）优先，否则取探针原文里的「用时 N 秒」；
 * 都没有（没真探、原文没写）不给，不拿 0 顶。
 */
export function probeSeconds(route: Route, requests: readonly RouteProbeRequest[]): number | undefined {
  const last = lastResultFor(requests, route.id);
  if (
    last?.result.durationMs !== undefined &&
    route.probe &&
    Date.parse(last.result.at) === Date.parse(route.probe.at)
  ) {
    return last.result.durationMs / 1000;
  }
  const m = route.probe?.detail ? LATENCY.exec(route.probe.detail) : null;
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : undefined;
}

/** 点下去之后一句话：在等谁、等了多久。 */
export function activityText(r: RouteProbeRequest, now: number): string {
  if (r.state === 'running') {
    const since = r.startedAt ? Math.max(0, Math.round((now - Date.parse(r.startedAt)) / 1000)) : 0;
    return `引擎已接手，在探（${since} 秒）`;
  }
  const waited = Math.max(0, Math.round((now - Date.parse(r.requestedAt)) / 1000));
  return r.why ?? `排队中（${waited} 秒），等引擎接手（引擎每 5 秒看一眼）`;
}
