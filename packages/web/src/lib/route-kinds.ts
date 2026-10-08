// 路由页上路由、模型这两层的状态词和颜色（#1366 第二部分，创始人要求把「死」拆开）：不再画后端的活 / 死 / 不知道，
// 改用 lib/route-state.ts 的八态（在线、故障、已关、未使用、下架、池暂停、未探、暂时挡着、不知道），只有故障画红。
// 判的是结构化事实（路由开关、渠道开关、模型下架、整池暂停、探针和额度三件事），和渠道状态页（channel-status.ts 的 routeKindMap）同一个 classifyRoute。
// 拿不到判态事实的（没配进任何用途的模型，路由两层里没有它的三件事）不在这里判：调用方保持置灰、不画态。

import type { RoutingLayerModel, RoutingLayerRoute } from '../api/types';
import { classifyRoute, type RouteStateKind, rollupKind } from './route-state';

/** 判态要的外部事实。读不到的不猜：渠道开关没读到给 undefined，下架、暂停没读到当没有（和 buildChannelCards 同一个做法）。 */
export interface KindEnv {
  channelEnabled(channelId: string): boolean | undefined;
  poolHeld(poolId: string): boolean;
  modelRetired(modelId: string): boolean;
}

export const NO_ENV: KindEnv = {
  channelEnabled: () => undefined,
  poolHeld: () => false,
  modelRetired: () => false,
};

/** 路由两层里的一条路由此刻是哪一种。路由两层里的路由都有用途在用。 */
export function routeKind(r: RoutingLayerRoute, modelId: string, env: KindEnv): RouteStateKind {
  return classifyRoute(r, {
    channelEnabled: env.channelEnabled(r.channelId),
    modelRetired: env.modelRetired(modelId),
    poolHeld: env.poolHeld(r.poolId),
    usedByPurpose: true,
  });
}

/** 模型这一层：下面每条路由各是哪一种，合成一个（有在线的就在线，没有在线有故障就故障……）。一条路由都没有返回 null（不画态）。 */
export function modelKind(
  m: Pick<RoutingLayerModel, 'modelId' | 'routes'>,
  env: KindEnv,
): RouteStateKind | null {
  if (m.routes.length === 0) return null;
  return rollupKind(m.routes.map((r) => routeKind(r, m.modelId, env)));
}
