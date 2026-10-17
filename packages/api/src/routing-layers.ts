// 驾驶舱「路由」页（#574）：路由两层每一层现在活着吗——用途 → 模型 → 路由，每层的结论和原因。
// 改这里之前必须知道：
// - 活不活只在 db 的 routing-liveness.ts 判（三件事、一层怎么合起来），这里只换成驾驶舱的形状，不再判一遍。
// - 没接上（开发环境的内存版没有这两张表）由接口写 unavailable；读不到抛，接口回 503 写明没读成。两样都不回空列表冒充「都没配」。
import {
  type Db,
  type RoutingLayers,
  type RoutingModelView,
  type RoutingRouteView,
  readRouteShare,
  recentRouteDispatches,
  routingLayers,
  shareAnnotations,
} from '@fleet-dao/db';
import {
  type Channel,
  type Model,
  ROUTING_PURPOSE_IDS,
  type RoutingLayerPurposeSchema,
  type RoutingLayerRouteSchema,
} from '@fleet-dao/shared';
import type { z } from 'zod';

/** 读路由两层的口子：流程里真在用的用途各一份（shared 的 ROUTING_PURPOSE_IDS），按那份的先后。读不到抛。 */
export interface RoutingLayersPort {
  read(input: { now: Date; staleAfterMs: number }): Promise<RoutingLayers[]>;
}

type ShareRoute = RoutingRouteView & {
  shareBand?: number;
  shareWeight?: number;
  recentDispatches?: number;
};
type ShareModel = RoutingModelView & { shareVersion?: number };

/** 同一档标在读出来的对象上，视图再抄进驾驶舱的形状。版本 0 不标；单独一条不算档。 */
function annotateShare(
  layers: RoutingLayers[],
  share: { version: number; map: Parameters<typeof shareAnnotations>[1] },
  recent: ReadonlyMap<string, number>,
): RoutingLayers[] {
  for (const layer of layers) {
    for (const model of layer.models) {
      if (share.version > 0) (model as ShareModel).shareVersion = share.version;
      const marks = shareAnnotations(
        model.routes.map((r) => ({ routeId: r.candidate.routeId, modelId: model.modelId })),
        share.map,
      );
      for (const route of model.routes) {
        const mark = marks.get(route.candidate.routeId);
        if (!mark) continue;
        const extra = route as ShareRoute;
        extra.shareBand = mark.shareBand;
        extra.shareWeight = mark.shareWeight;
        extra.recentDispatches = recent.get(route.candidate.routeId) ?? 0;
      }
    }
  }
  return layers;
}

export function pgRoutingLayers(db: Db): RoutingLayersPort {
  return {
    read: async ({ now, staleAfterMs }) => {
      const layers = await Promise.all(
        ROUTING_PURPOSE_IDS.map((purpose) => routingLayers(db, purpose, { now, staleAfterMs })),
      );
      const share = await readRouteShare(db);
      const recent = await recentRouteDispatches(db, now);
      return annotateShare(layers, share, recent);
    },
  };
}

/** 开发环境、内存版：没有这两张表。 */
export const ROUTING_LAYERS_NOT_HERE =
  '路由两层没接上：这里是开发环境的内存版，没有路由两层那两张表（routing_purpose_models、routing_catalog），真库上才有';

function routeView(r: RoutingRouteView, channels: ReadonlyMap<string, Channel>) {
  const c = r.candidate;
  return {
    routeId: c.routeId,
    channelId: c.channelId,
    channelName: channels.get(c.channelId)?.name ?? c.channelId,
    poolId: c.poolId,
    hostId: c.hostId,
    enabled: !c.blockers.includes('switched-off'),
    verdict: r.verdict,
    connect: r.liveness.connect,
    quota: r.liveness.quota,
    ban: r.liveness.ban,
    ...(c.probedAt ? { probedAt: c.probedAt.toISOString() } : {}),
    ...(c.probeDetail ? { probeDetail: c.probeDetail } : {}),
    // 节奏列（#1798 片 6）：库里写过的原样转出；老行（四列都没写过）一个都不给，fail_streak 不拿默认 0 顶。
    // 「写过没有」由 db 的 probePace.written 判（shared 的 probePaceWritten 一处判法），这里照它给。
    ...(r.probePace.written
      ? {
          ...(r.probePace.tier != null ? { probeTier: r.probePace.tier } : {}),
          ...(r.probePace.nextAt != null ? { probeNextAt: r.probePace.nextAt.toISOString() } : {}),
          probeFailStreak: r.probePace.failStreak,
          ...(r.probePace.kind != null ? { probeKind: r.probePace.kind } : {}),
        }
      : {}),
    // 疑似换模型和上次触发者（#1846）：库里空的（没判过、老行）不给。
    ...(c.suspectedSwap != null ? { suspectedSwap: c.suspectedSwap } : {}),
    ...(c.probeTrigger != null ? { probeTrigger: c.probeTrigger } : {}),
    exhausted: c.windows
      .filter((w) => w.applies === 'yes' && w.state === 'exhausted')
      .map((w) => ({ label: w.label, ...(w.resetsAt ? { resetsAt: w.resetsAt.toISOString() } : {}) })),
    inFlight: c.inFlight,
    reserved: c.reserved,
    maxConcurrency: c.maxConcurrency,
    ...shareFields(r),
  } satisfies z.input<typeof RoutingLayerRouteSchema>;
}

function shareFields(r: RoutingRouteView): {
  shareBand?: number;
  shareWeight?: number;
  recentDispatches?: number;
} {
  const extra = r as RoutingRouteView & {
    shareBand?: number;
    shareWeight?: number;
    recentDispatches?: number;
  };
  if (extra.shareBand === undefined) return {};
  return {
    shareBand: extra.shareBand,
    shareWeight: extra.shareWeight ?? 1,
    recentDispatches: extra.recentDispatches ?? 0,
  };
}

/** 换成驾驶舱的形状：模型、渠道的名字从目录里查，查不到就写编号（不丢这一行）。 */
export function routingLayersView(
  layers: readonly RoutingLayers[],
  catalog: { models: readonly Model[]; channels: readonly Channel[] },
): z.input<typeof RoutingLayerPurposeSchema>[] {
  const models = new Map(catalog.models.map((m) => [m.id, m]));
  const channels = new Map(catalog.channels.map((c) => [c.id, c]));
  return layers.map((layer) => ({
    purpose: layer.purpose,
    version: layer.version,
    verdict: layer.verdict,
    problems: layer.problems,
    models: layer.models.map((m) => {
      const model = models.get(m.modelId);
      const family = model?.family ?? m.routes[0]?.candidate.family;
      return {
        modelId: m.modelId,
        displayName: model?.displayName ?? m.modelId,
        ...(family ? { family } : {}),
        ...(model?.strength ? { strength: model.strength } : {}),
        ...(m.effort ? { effort: m.effort } : {}),
        ...((m as ShareModel).shareVersion ? { shareVersion: (m as ShareModel).shareVersion } : {}),
        verdict: m.verdict,
        routes: m.routes.map((r) => routeView(r, channels)),
      };
    }),
  }));
}
