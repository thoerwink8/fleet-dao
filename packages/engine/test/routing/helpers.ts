// 造选路输入的小工具。池名、路由编号都是占位，不带任何账号信息。
import type { ChooseRouteInput, RouteFacts, RouteWindow, StageRouteEntry } from '../../src/routing/index.ts';

export const NOW = '2026-09-25T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);

/** 离现在 h 小时的时刻（负数 = 过去）。 */
export function at(hours: number): string {
  return new Date(NOW_MS + hours * 3_600_000).toISOString();
}

export function win(overrides: Partial<RouteWindow> = {}): RouteWindow {
  return {
    label: '7d',
    window: '7d',
    scope: null,
    state: 'ok',
    applies: 'yes',
    used: 0.5,
    resetsAt: at(72),
    reading: 'measured',
    readAt: at(-0.1),
    staleSince: null,
    ...overrides,
  };
}

export function route(routeId: string, overrides: Partial<RouteFacts> = {}): RouteFacts {
  return {
    routeId,
    channelId: 'claude-subscription',
    poolId: `pool-${routeId}`,
    poolName: `池${routeId}`,
    poolRole: 'primary',
    modelId: 'opus-5.5',
    modelName: 'Opus 5.5',
    family: 'claude',
    hostId: 'claude-code',
    upstreamModel: null,
    upstreamAliases: [],
    quota: 'ok',
    windows: [win({ label: '5h', window: '5h', used: 0.2, resetsAt: at(3) }), win()],
    inFlight: 0,
    maxConcurrency: 5,
    banReasons: [],
    blockers: [],
    breaker: { state: 'closed', admit: 'all', reason: '正常' },
    record: null,
    ...overrides,
  };
}

export function entry(
  routeId: string,
  position: number,
  overrides: Partial<StageRouteEntry> = {},
): StageRouteEntry {
  return { routeId, position, enabled: true, pinned: false, ...overrides };
}

/** 按给的顺序排好一个阶段：第 i 条路由位置 i。 */
export function input(routes: RouteFacts[], overrides: Partial<ChooseRouteInput> = {}): ChooseRouteInput {
  return {
    stage: 'execute',
    configured: true,
    stagePinned: false,
    order: routes.map((r, i) => entry(r.routeId, i)),
    routes,
    now: NOW,
    ...overrides,
  };
}

/** 独享号（主池）与拼车号（备池）两条 Claude 路由，别的字段照常。 */
export function soloAndCarpool(
  solo: Partial<RouteFacts> = {},
  carpool: Partial<RouteFacts> = {},
): [RouteFacts, RouteFacts] {
  return [
    route('solo', { poolId: 'pool-solo', poolName: '独享号', ...solo }),
    route('carpool', { poolId: 'pool-carpool', poolName: '拼车号', poolRole: 'backup', ...carpool }),
  ];
}
