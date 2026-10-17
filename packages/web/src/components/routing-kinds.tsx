// 路由页判态要的外部事实（渠道开关、模型下架、整池暂停）从目录和整池暂停现读，交给 lib/route-kinds.ts 判。
// 没读到的不猜（见 KindEnv）。

import { useMemo } from 'react';
import { usePoolHolds, useRouting } from '../api/client';
import { useNow } from '../lib/hooks';
import { poolIsHeld } from '../lib/pool-holds';
import type { KindEnv } from '../lib/route-kinds';
import { type RouteStateKind, routeStateLabel, routeStateTone, routeStateWhy } from '../lib/route-state';
import { StatusBadge, type StatusBadgeVariant, StatusDot } from './layout/status-badge';

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
      now,
    }),
    [channels, models, held, now],
  );
}

/**
 * 状态词的芯片。悬停是这一种的说明（routeStateWhy）；额度耗尽的路由不走这颗芯片。
 * 说明写在胶囊的 title 上，不外包 span：目录行 `[data-status-word]` 里第一层就是带 data-tone 的胶囊。
 */
export function KindChip({ kind, variant }: { kind: RouteStateKind; variant?: StatusBadgeVariant }) {
  const why = routeStateWhy[kind];
  // 疑似换模型和探测记录里的「疑似换模型」同一个橙色，和不通的红分开（#1748、#1798）
  if (kind === 'degraded') return <DoubtChip label={routeStateLabel[kind]} title={why} variant={variant} />;
  return (
    <StatusBadge
      tone={routeStateTone[kind]}
      label={routeStateLabel[kind]}
      title={why}
      {...(variant ? { variant } : {})}
    />
  );
}

/** 橙色的「疑似换模型」芯片：身份题说出了旧答案，已按不在线处理，不是红的故障。 */
export function DoubtChip({
  label,
  title,
  variant,
}: {
  label: string;
  title?: string;
  variant?: StatusBadgeVariant | undefined;
}) {
  return (
    <span title={title} className="inline-flex shrink-0">
      <StatusBadge tone="doubt" label={label} {...(variant ? { variant } : {})} />
    </span>
  );
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
