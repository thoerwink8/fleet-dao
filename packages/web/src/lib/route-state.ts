// 一条路由、一个渠道此刻「是什么状态」的白话（#1363）：把「死」拆开。
// 原来后端的「死」（routing-liveness.ts 的 dead）把几样事混在一起：人关掉了、没有任何用途在用、模型下架、整池暂停、
// 从没探过，和真正该修的「该在线却探不通」都叫死、都画红。告警只该看最后一样。
// 这里不重新判能不能派（那是后端现算的 verdict，选路和这页看同一份）：只用结构化事实（开关、下架时间、整池暂停、
// 有没有用途在用、探针看没看过）把「死」分清是哪一种，再决定用什么词、什么颜色、算不算进告警。
//
// 改这里之前必须知道：
// - 只有 fault（故障）画红、进告警口径：该在线（开着、没暂停、有用途在用、没下架）却探不通。
// - 已关 / 未被用途使用 / 下架 / 池暂停是人或配置的结果，不是坏了：用灰（stop）或停滞色，不画红，不算「0 条活」的告警。
// - 判的先后写死：下架 → 已关 → 池暂停 → 未被用途使用 → 再看探针和额度。同一条路由只落一种。

import { isOnDemandDetail } from '@fleet-dao/shared';
import type { RoutingLayerRoute } from '../api/types';
import type { Tone } from './status';

export type RouteStateKind =
  /** 在线：开着、探通、额度够、没被挡。 */
  | 'live'
  /** 故障（该修）：该在线却探不通。 */
  | 'fault'
  /** 已关：人把开关关了（路由、模型或渠道）。 */
  | 'off'
  /** 未被用途使用：没有任何用途排了它，不花额度去探。 */
  | 'unused'
  /** 下架：模型下架了，派不到。 */
  | 'retired'
  /** 池暂停：这条路由的账号池整池暂停，要人撤。 */
  | 'held'
  /** 未探：探针还没看过。 */
  | 'unprobed'
  /** 按需探测：不在用途前 2 位，定时探针不主动探；要派给它时派前先探一次（#1635）。不是坏了，不画红。 */
  | 'on_demand'
  /** 暂时挡着：额度用满、命中禁令、引擎暂不往它派；不是坏了，等清零或撤禁令。 */
  | 'blocked'
  /** 不知道：探针这一轮没探它、额度没读成。 */
  | 'unknown';

export const ROUTE_STATE_KINDS: readonly RouteStateKind[] = [
  'live',
  'fault',
  'blocked',
  'unknown',
  'on_demand',
  'unprobed',
  'off',
  'unused',
  'retired',
  'held',
];

export const routeStateLabel: Record<RouteStateKind, string> = {
  live: '在线',
  fault: '故障',
  off: '已关',
  unused: '未被用途使用',
  retired: '已下架',
  held: '池暂停',
  unprobed: '未探',
  on_demand: '按需探测',
  blocked: '暂时挡着',
  unknown: '不知道',
};

/** 颜色：只有故障红；在线绿；人关、没用、下架、暂停一律灰（停）；其余要人看一眼的用停滞色。 */
export const routeStateTone: Record<RouteStateKind, Tone> = {
  live: 'done',
  fault: 'fail',
  off: 'stop',
  unused: 'stop',
  retired: 'stop',
  held: 'stall',
  unprobed: 'stall',
  on_demand: 'stop',
  blocked: 'stall',
  unknown: 'stall',
};

/** 一句话说清这一种是什么意思（详情里写，也给悬停提示用）。 */
export const routeStateWhy: Record<RouteStateKind, string> = {
  live: '开着、探针探通、额度够、没被禁令挡',
  fault: '该在线却探不通：要人修',
  off: '人把开关关了：不派，不算坏',
  unused: '没有任何用途排了它：不探，不算坏',
  retired: '模型已下架：派不到，不算坏',
  held: '账号池整池暂停：要人撤了暂停才派',
  unprobed: '探针还没看过：不知道通不通',
  on_demand: '不主动探，要派给它时先探一次：不算坏，不算过期',
  blocked: '额度用满、命中禁令或引擎暂不往它派：不是坏了',
  unknown: '探针这一轮没探它，或额度没读成：不当活，也不当坏',
};

/** 进告警口径的只有故障。 */
export const isAlert = (kind: RouteStateKind): boolean => kind === 'fault';

/** 筛选器上的四档：全部 / 故障 / 已关 / 未使用。「已关」把人关的、下架、池暂停归在一起：都是没在派，但不是坏。 */
export type StateFilter = 'all' | 'fault' | 'off' | 'unused';

export const STATE_FILTERS: readonly { id: StateFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'fault', label: '故障' },
  { id: 'off', label: '已关' },
  { id: 'unused', label: '未使用' },
];

export function matchesFilter(kind: RouteStateKind, filter: StateFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'fault') return kind === 'fault';
  if (filter === 'off') return kind === 'off' || kind === 'retired' || kind === 'held';
  return kind === 'unused';
}

/** 判一条路由要的外部事实：不在这条路由自己身上的那几样。 */
export interface RouteStateContext {
  /** 渠道目录里这个渠道开着吗；目录没读到给 undefined（不猜）。 */
  channelEnabled?: boolean | undefined;
  /** 这条路由的模型下架了吗。 */
  modelRetired?: boolean;
  /** 这条路由所属账号池整池暂停了吗。 */
  poolHeld?: boolean;
  /** 有没有任何用途在用它；路由页上的路由都在用途下，给 true（默认）。 */
  usedByPurpose?: boolean;
}

/** 后端给的三件事 + 路由开关，加上外部事实 → 这条路由是哪一种。 */
export function classifyRoute(
  r: Pick<
    RoutingLayerRoute,
    'enabled' | 'verdict' | 'connect' | 'quota' | 'ban' | 'probedAt' | 'probeDetail'
  >,
  ctx: RouteStateContext = {},
): RouteStateKind {
  if (ctx.modelRetired) return 'retired';
  if (ctx.channelEnabled === false || !r.enabled) return 'off';
  if (ctx.poolHeld) return 'held';
  if (ctx.usedByPurpose === false) return 'unused';
  if (isOnDemandDetail(r.probeDetail)) return 'on_demand';
  if (r.connect.verdict === 'dead') return 'fault';
  if (r.connect.verdict === 'unknown') return r.probedAt === undefined ? 'unprobed' : 'unknown';
  if (r.quota.verdict === 'dead' || r.ban.verdict === 'dead') return 'blocked';
  if (r.quota.verdict === 'unknown' || r.ban.verdict === 'unknown') return 'unknown';
  return 'live';
}

/** 没有结构化事实、只有探针原始结论的路由（渠道状态页里没排进用途的路由）：开关、下架、暂停、有没有用途在用，再看探针。 */
export function classifyProbe(
  probe: { state: 'ok' | 'failed' | 'skipped' | 'not_wired' | 'on_demand' } | undefined,
  ctx: RouteStateContext = {},
): RouteStateKind {
  if (ctx.modelRetired) return 'retired';
  if (ctx.channelEnabled === false) return 'off';
  if (ctx.poolHeld) return 'held';
  if (ctx.usedByPurpose === false) return 'unused';
  if (!probe) return 'unprobed';
  if (probe.state === 'on_demand') return 'on_demand';
  if (probe.state === 'ok') return 'live';
  if (probe.state === 'failed') return 'fault';
  return 'unknown';
}

export type KindCounts = Record<RouteStateKind, number>;

export function countKinds(kinds: readonly RouteStateKind[]): KindCounts {
  const out = Object.fromEntries(ROUTE_STATE_KINDS.map((k) => [k, 0])) as KindCounts;
  for (const k of kinds) out[k] += 1;
  return out;
}

/**
 * 一组路由（一个模型下的、一个渠道下的）合成一个状态：有在线的就在线；没有在线、有故障就故障；
 * 其余照最「该看」的排：暂时挡着 → 不知道 → 未探 → 池暂停 → 已关 → 下架 → 未被用途使用。一条都没有按未被用途使用。
 * 全是已关、没用的组不会因此变成故障，也不进告警。
 */
export function rollupKind(kinds: readonly RouteStateKind[]): RouteStateKind {
  const order: readonly RouteStateKind[] = [
    'live',
    'fault',
    'blocked',
    'unknown',
    'on_demand',
    'unprobed',
    'held',
    'off',
    'retired',
    'unused',
  ];
  for (const k of order) if (kinds.includes(k)) return k;
  return 'unused';
}

/** 一行摘要：「2 在线 · 1 故障 · 3 已关」。零的不写；一条都没有写「没有路由」。已关把人关的、下架、池暂停合起来数。 */
export function countsText(counts: KindCounts): string {
  const off = counts.off + counts.retired + counts.held;
  const other = counts.blocked + counts.unknown + counts.unprobed;
  const onDemand = counts.on_demand;
  const parts = [
    counts.live > 0 ? `${counts.live} 在线` : undefined,
    counts.fault > 0 ? `${counts.fault} 故障` : undefined,
    onDemand > 0 ? `${onDemand} 按需` : undefined,
    other > 0 ? `${other} 待查` : undefined,
    off > 0 ? `${off} 已关` : undefined,
    counts.unused > 0 ? `${counts.unused} 未使用` : undefined,
  ].filter((x): x is string => x !== undefined);
  return parts.length > 0 ? parts.join(' · ') : '没有路由';
}
