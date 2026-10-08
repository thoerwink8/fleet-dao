// 路由页判态要的外部事实（渠道开关、模型下架、整池暂停）从目录和整池暂停现读，交给 lib/route-kinds.ts 判。
// 没读到的不猜（见 KindEnv）。

import { useMemo } from 'react';
import { usePoolHolds, useRouting } from '../api/client';
import { useNow } from '../lib/hooks';
import { poolIsHeld } from '../lib/pool-holds';
import type { KindEnv } from '../lib/route-kinds';
import { type RouteStateKind, routeStateLabel, routeStateTone, routeStateWhy } from '../lib/route-state';
import { StatusChip, StatusDot } from './status';

export function useKindEnv(): KindEnv {
  const routing = useRouting();
  const holds = usePoolHolds();
  const now = useNow();
  const channels = routing.data?.channels;
  const models = routing.data?.models;
  const held = holds.data;
  return useMemo<KindEnv>(
    () => ({
      channelEnabled: (id) => channels?.find((c) => c.id === id)?.enabled,
      poolHeld: (poolId) => Boolean(held && poolIsHeld(held, poolId)),
      modelRetired: (modelId) => {
        const at = models?.find((m) => m.id === modelId)?.retiredAt;
        return at !== undefined && Date.parse(at) <= now;
      },
    }),
    [channels, models, held, now],
  );
}

/** 状态词的芯片。 */
export function KindChip({ kind }: { kind: RouteStateKind }) {
  return <StatusChip tone={routeStateTone[kind]} label={routeStateLabel[kind]} />;
}

/** 状态点：颜色按八态，读屏和悬停写词和一句意思；null = 判不了，不画态（留同样宽的空位，行不跳）。 */
export function KindDot({
  kind,
  className,
  whyNot,
}: {
  kind: RouteStateKind | null;
  className?: string;
  /** kind 为空时读屏写什么。 */
  whyNot: string;
}) {
  if (kind === null) {
    return (
      <>
        <span aria-hidden className={`inline-block size-2 shrink-0 ${className ?? ''}`} />
        <span className="sr-only">：{whyNot}</span>
      </>
    );
  }
  return (
    <>
      <StatusDot tone={routeStateTone[kind]} {...(className ? { className } : {})} />
      <span className="sr-only" title={routeStateWhy[kind]}>
        ：{routeStateLabel[kind]}
      </span>
    </>
  );
}
