// 单子页「用哪个模型」怎么说（驾驶舱改版 2026-10-07：「每个任务能点进去随意切换模型」）。
// 指定存在库里（task_route_pins），引擎每次给这一段选路时现读：在跑的这一轮不打断，下一次选路就照它；
// 指定的模型派不出时引擎停下等人、不悄悄换别的——所以页面要在选的时候、选了之后都说清它现在派不派得出。
// 派不派得出只照后端现算的路由两层（GET /routing/layers，和选路同一份事实），这里不另判。
import { routingPurposeLabel, SEGMENT_STAGE, type SegmentKind } from '@fleet-dao/shared';
import type {
  RoutingLayerModel,
  RoutingLayerRoute,
  RoutingLayers,
  StageKind,
  TaskDetail,
  TaskRoutePin,
} from '../api/types';
import { stageLabel } from './catalog';

/** 经选路的两段：动手、验收。对题在对话里做，不经引擎选路。 */
export type RoutedSegment = 'manual' | 'verify';
export const ROUTED_SEGMENTS: readonly RoutedSegment[] = ['manual', 'verify'];

/** 每段按哪个用途选路：和引擎同一份（shared 的 SEGMENT_STAGE：动手按 execute，验收按页面上的「验收」）。 */
export const SEGMENT_PURPOSE: Record<RoutedSegment, StageKind> = SEGMENT_STAGE;

function purposeName(stage: StageKind): string {
  return routingPurposeLabel(stage) ?? stageLabel[stage];
}

/** 「自动」在下拉里的值（Radix 的 Select 不收空串）。 */
export const AUTO = 'auto';

export type Liveness = { verdict: 'live' } | { verdict: 'dead' | 'unknown'; why: string };

export interface ModelChoice {
  modelId: string;
  name: string;
  liveness: Liveness;
  routes: { routeId: string; name: string; liveness: Liveness }[];
}

function routeLiveness(r: RoutingLayerRoute): Liveness {
  if (r.verdict === 'live') return { verdict: 'live' };
  const facts = [r.connect, r.quota, r.ban].filter((f) => f.verdict === r.verdict).map((f) => f.reason);
  return { verdict: r.verdict, why: facts.join('；') || '没说原因' };
}

function modelLiveness(m: RoutingLayerModel): Liveness {
  if (m.verdict === 'live') return { verdict: 'live' };
  if (m.routes.length === 0) return { verdict: 'dead', why: '这个模型下一条路由都没有' };
  const why = m.routes
    .map((r) => {
      const l = routeLiveness(r);
      return l.verdict === 'live' ? null : `${r.channelName}：${l.why}`;
    })
    .filter(Boolean)
    .join('；');
  return { verdict: m.verdict, why: why || '没说原因' };
}

/** 这个用途下能指定的模型（路由两层的顺序：先模型，再模型下的路由）。读不了、认不出用途的给 problem。 */
export function choicesFor(
  layers: RoutingLayers,
  segment: RoutedSegment,
): { models: ModelChoice[] } | { problem: string } {
  const stage = SEGMENT_PURPOSE[segment];
  if (layers.unavailable) return { problem: `路由两层读不了：${layers.unavailable}` };
  const purpose = layers.purposes.find((p) => p.purpose === stage);
  if (!purpose) return { problem: `后端回的路由两层里没有「${purposeName(stage)}」这个用途` };
  return {
    models: purpose.models.map((m) => ({
      modelId: m.modelId,
      name: m.displayName,
      liveness: modelLiveness(m),
      routes: m.routes.map((r) => ({
        routeId: r.routeId,
        name: `${r.channelName} · ${r.poolId}`,
        liveness: routeLiveness(r),
      })),
    })),
  };
}

/**
 * 指定的模型（钉了路由的看那条）现在派不派得出。不在这个用途的路由两层里的：引擎派不出、会停下等人（store-ports.ts 写
 * 「没有接上的路由」），照实说。
 */
export function pinLiveness(
  models: readonly ModelChoice[],
  pin: ActivePin,
  segment: RoutedSegment,
): Liveness {
  const m = models.find((x) => x.modelId === pin.modelId);
  if (!m) {
    return {
      verdict: 'dead',
      why: `它不在「${purposeName(SEGMENT_PURPOSE[segment])}」用途的路由两层里，引擎派不出`,
    };
  }
  if (!pin.routeId) return m.liveness;
  const r = m.routes.find((x) => x.routeId === pin.routeId);
  return r ? r.liveness : { verdict: 'dead', why: `钉的路由 ${pin.routeId} 不在这个模型下了` };
}

/** 生效中的指定（清掉了的不算）。 */
export type ActivePin = TaskRoutePin & { modelId: string };

export function activePin(d: TaskDetail, segment: RoutedSegment): ActivePin | undefined {
  const p = d.routePins.pins.find((x) => x.segment === segment);
  return p?.modelId ? (p as ActivePin) : undefined;
}

/** 这一段最近一笔：模型和在不在跑（「这一轮在跑的是谁」）。 */
export function latestRun(
  d: TaskDetail,
  segment: SegmentKind,
): TaskDetail['segmentRuns'][number] | undefined {
  return d.segmentRuns.filter((r) => r.segment === segment).at(-1);
}
