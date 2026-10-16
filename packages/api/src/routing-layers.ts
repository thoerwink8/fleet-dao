// 驾驶舱「路由」页（#574）：路由两层每一层现在活着吗——用途 → 模型 → 路由，每层的结论和原因。
// 改这里之前必须知道：
// - 活不活只在 db 的 routing-liveness.ts 判（三件事、一层怎么合起来），这里只换成驾驶舱的形状，不再判一遍。
// - 没接上（开发环境的内存版没有这两张表）由接口写 unavailable；读不到抛，接口回 503 写明没读成。两样都不回空列表冒充「都没配」。
import { type Db, type RoutingLayers, type RoutingRouteView, routingLayers } from '@fleet-dao/db';
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

export function pgRoutingLayers(db: Db): RoutingLayersPort {
  return {
    read: ({ now, staleAfterMs }) =>
      Promise.all(ROUTING_PURPOSE_IDS.map((purpose) => routingLayers(db, purpose, { now, staleAfterMs }))),
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
  } satisfies z.input<typeof RoutingLayerRouteSchema>;
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
        verdict: m.verdict,
        routes: m.routes.map((r) => routeView(r, channels)),
      };
    }),
  }));
}
