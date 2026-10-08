// 路由页（/routing，#574）的白话和先看哪个：活不活由后端现算（db 的 routing-liveness.ts，判法只在那里），这里只管怎么说。

import { poolFull, poolOccupied, routeProbeStaleMinutes, routingPurposeOf } from '@fleet-dao/shared';
import type {
  LivenessVerdict,
  RoutingLayerModel,
  RoutingLayerPurpose,
  RoutingLayerRoute,
} from '../api/types';
import { hostLabel, stageLabel } from './catalog';
import { TIME } from './format';
import type { Tone } from './status';

/** 活 = 完成色；死 = 失败色；不知道 = 停滞色（要人看，但不是坏了）。 */
export const verdictTone: Record<LivenessVerdict, Tone> = { live: 'done', dead: 'fail', unknown: 'stall' };

/** 用途这一层说成派不派得出去。 */
export const purposeVerdictLabel: Record<LivenessVerdict, string> = {
  live: '派得出去',
  dead: '派不出去',
  unknown: '不知道',
};

/** 这一格在路由页上的名字。不在对照里的用途不该被画出来（调用方先滤掉）。 */
export function purposeLabel(purpose: RoutingLayerPurpose['purpose']): string {
  return routingPurposeOf(purpose)?.label ?? stageLabel[purpose];
}

/** 一条路由给人看的名字：渠道 · 账号池。执行方式另起一行（hostLabel）。 */
export function routeTitle(r: Pick<RoutingLayerRoute, 'channelName' | 'poolId'>): string {
  return `${r.channelName} · ${r.poolId}`;
}

export function routeHost(r: Pick<RoutingLayerRoute, 'hostId'>): string {
  return hostLabel[r.hostId];
}

/**
 * 这条路由的账号池占着几个名额、满没满（#800）：在跑的 + 已选定还没开跑的（选路在选定那一刻就预占名额），到上限就是满。
 * 满不满只有 shared 的 poolFull 一个判法（引擎选路、路由页同一个）：路由页经这里，不另写一份。
 * count：没有已选定的是「1/3」，有的把两样各写明：「3/3（在跑 1、已选定还没开跑 2）」；text 是路由页那一句（加前缀「在跑」「占」）。
 */
export function routeSlots(r: Pick<RoutingLayerRoute, 'inFlight' | 'reserved' | 'maxConcurrency'>): {
  full: boolean;
  occupied: number;
  count: string;
  text: string;
} {
  const occupied = poolOccupied(r);
  const reserved = r.reserved > 0;
  const count = reserved
    ? `${occupied}/${r.maxConcurrency}（在跑 ${r.inFlight}、已选定还没开跑 ${r.reserved}）`
    : `${r.inFlight}/${r.maxConcurrency}`;
  return { full: poolFull(r), occupied, count, text: `${reserved ? '占' : '在跑'} ${count}` };
}

export interface FirstLive {
  model: RoutingLayerModel;
  modelIndex: number;
  route: RoutingLayerRoute;
  routeIndex: number;
}

/** 顺位上第一条活的路：先模型的先后、再模型下路由的先后。一条都没有是 undefined。 */
export function firstLive(p: Pick<RoutingLayerPurpose, 'models'>): FirstLive | undefined {
  for (const [modelIndex, model] of p.models.entries()) {
    const routeIndex = model.routes.findIndex((r) => r.verdict === 'live');
    const route = model.routes[routeIndex];
    if (route) return { model, modelIndex, route, routeIndex };
  }
  return undefined;
}

/** 首选（第 1 个模型的第 1 条路）不是活的，活的是靠后的那条：在靠后备撑着。 */
export function onFallback(p: Pick<RoutingLayerPurpose, 'models'>): boolean {
  const first = firstLive(p);
  return first !== undefined && (first.modelIndex > 0 || first.routeIndex > 0);
}

/** 用途一句话：走的是不是首选；不是首选，顺位上第一条活的是哪条；派不出去为什么。 */
export function purposeLine(p: RoutingLayerPurpose): { text: string; tone: Tone } {
  const first = firstLive(p);
  if (first) {
    const where = `${first.model.displayName}（${routeTitle(first.route)}）`;
    if (first.modelIndex === 0 && first.routeIndex === 0) return { text: `首选活着：${where}`, tone: 'done' };
    if (first.modelIndex === 0) {
      return {
        text: `首选那条路不行，顺位第一条活的是它的第 ${first.routeIndex + 1} 条：${where}`,
        tone: 'stall',
      };
    }
    return {
      text: `首选模型不行，顺位第一条活的在第 ${first.modelIndex + 1} 个模型：${where}`,
      tone: 'stall',
    };
  }
  if (p.verdict === 'unknown') {
    const n = p.models.flatMap((m) => m.routes).filter((r) => r.verdict === 'unknown').length;
    return { text: `没有确定活着的：${n} 条不知道（探针没看过、额度没读成）`, tone: 'stall' };
  }
  if (p.models.length === 0) return { text: p.problems[0] ?? '这个用途没有模型，派不了', tone: 'fail' };
  return { text: '一条活的都没有：下面逐条写了为什么', tone: 'fail' };
}

/** 一个模型下几条路、几条活。 */
export function modelSummary(m: Pick<RoutingLayerModel, 'routes'>): string {
  if (m.routes.length === 0) return '一条路由都没有';
  const live = m.routes.filter((r) => r.verdict === 'live').length;
  return `${m.routes.length} 条路，${live} 条活`;
}

/**
 * 进页面先看哪个用途：网址里点名的（?purpose=）优先；没点名先看派不出去的，再看不知道的，再看靠后备撑着的，都好就看第一个。
 * 点名的不在列表里（写错了）照没点名算。
 */
export function pickPurpose(
  purposes: readonly RoutingLayerPurpose[],
  wanted: string | null,
): RoutingLayerPurpose | undefined {
  const named = purposes.find((p) => p.purpose === wanted);
  if (named) return named;
  return (
    purposes.find((p) => p.verdict === 'dead') ??
    purposes.find((p) => p.verdict === 'unknown') ??
    purposes.find((p) => onFallback(p)) ??
    purposes[0]
  );
}

/** 各结论几个用途。 */
export function countByVerdict(
  purposes: readonly { verdict: LivenessVerdict }[],
): Record<LivenessVerdict, number> {
  const out: Record<LivenessVerdict, number> = { live: 0, dead: 0, unknown: 0 };
  for (const p of purposes) out[p.verdict] += 1;
  return out;
}

/**
 * 探针的结论过期了没有：超过 routeProbeStaleMinutes（按执行方式，放慢的按它的间隔再加两轮）没更新，探针可能停了。
 * 引擎照上一次的结论派、写明（routing/choose.ts 的 probeNote），驾驶舱同一条线标出来，不改结论。
 */
export function probeStale(r: Pick<RoutingLayerRoute, 'probedAt' | 'hostId'>, now: number): boolean {
  return (
    r.probedAt !== undefined && now - Date.parse(r.probedAt) > routeProbeStaleMinutes(r.hostId) * TIME.MIN
  );
}
