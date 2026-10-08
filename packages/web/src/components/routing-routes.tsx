// 路由页上「一个模型下的路由」那一块（#574，#1366 第二部分）：每条路由的活 / 死 / 不知道和三件事的原因、开关、整池暂停。
// 用途页（选中一个模型）、模型目录页（选中一个模型）、渠道页（选中一个渠道，看它在各个模型下的路由）共用。
// 改这里之前必须知道：
// - 不知道（探针没看过、额度没读成）不画成活，也不画成死：用停滞色，原因照写。
// - 渠道已关时这条路由不画开关，写「渠道已关」；整池暂停、整池暂停没读成时开关置灰并写原因。

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { usePoolHolds, useRouting } from '../api/client';
import type { LivenessFact, RoutingLayerModel, RoutingLayerRoute } from '../api/types';
import { formatAgo, formatIn } from '../lib/format';
import { poolIsHeld } from '../lib/pool-holds';
import { routeKind } from '../lib/route-kinds';
import { probeStale, routeHost, routeSlots, routeTitle } from '../lib/routing';
import { type Tone, toneText } from '../lib/status';
import { cn } from '../lib/utils';
import { RouteSwitch, SortableList, useRoutingEdit } from './routing-edit';
import { PoolHoldControl } from './routing-hold';
import { KindChip, useKindEnv } from './routing-kinds';
import { StatusDot } from './status';
import { Badge } from './ui/badge';

/** 一个模型下的路由，可拖动改先后（先后不分用途，管这个模型在所有用途里）。 */
export function ModelRoutes({
  model: m,
  now,
  firstLiveRoute,
}: {
  model: RoutingLayerModel;
  now: number;
  firstLiveRoute?: string | undefined;
}) {
  const edit = useRoutingEdit();
  if (m.routes.length === 0) {
    return <p className="px-3 py-2.5 text-sub text-ink-fail">这个模型下一条路由都没有：排了它也派不到它</p>;
  }
  return (
    <SortableList
      ariaLabel={`${m.displayName} 的路由`}
      items={m.routes}
      itemId={(r) => r.routeId}
      itemLabel={(r) => `${routeTitle(r)}（${m.displayName} 下的先后）`}
      disabled={edit.disabledWhy !== null}
      busy={edit.busy}
      disabledWhy={edit.disabledWhy}
      rowClassName={(r) => cn('border-b px-3 py-2.5 last:border-b-0', !r.enabled && 'bg-muted/30')}
      rowProps={(r) => ({ 'data-route': r.routeId })}
      onSave={(order, expected, movedId) =>
        edit.reorderRoutes({ modelId: m.modelId, movedId, order, expected })
      }
    >
      {(r, i, controls) => (
        <RouteItem
          route={r}
          index={i}
          modelId={m.modelId}
          modelName={m.displayName}
          controls={
            <span className="inline-flex shrink-0 items-center">
              {controls.pins}
              {controls.grip}
            </span>
          }
          now={now}
          firstLive={r.routeId === firstLiveRoute}
        />
      )}
    </SortableList>
  );
}

export function RouteItem({
  route: r,
  index,
  modelId,
  modelName,
  modelLabel,
  controls,
  now,
  firstLive: isFirst,
}: {
  route: RoutingLayerRoute;
  /** 在模型下的第几条（从 0 起）；不给就不写序号（渠道页里的路由不分先后）。 */
  index?: number;
  modelId: string;
  modelName: string;
  /** 渠道页里写明这条路由属于哪个模型。 */
  modelLabel?: string;
  /** 置顶 / 置底 / 拖动；不给就没有（渠道页里不调先后）。 */
  controls?: ReactNode;
  now: number;
  firstLive?: boolean;
}) {
  const stale = probeStale(r, now);
  const slots = routeSlots(r);
  const edit = useRoutingEdit();
  const routing = useRouting();
  const holds = usePoolHolds();
  const name = routeTitle(r);
  // 状态词和颜色：后端的「死」拆开，只有故障画红（lib/route-state.ts）
  const kind = routeKind(r, modelId, useKindEnv());
  // 目录没读到不猜渠道关没关：只有读到了且 enabled 为 false 才换成「渠道已关」。
  const channelOff = routing.data
    ? routing.data.channels.find((c) => c.id === r.channelId)?.enabled === false
    : false;
  const poolLocked = Boolean(holds.data && poolIsHeld(holds.data, r.poolId));
  const lockWhy = holds.error
    ? '整池暂停没读成，先不能开这条路由'
    : poolLocked
      ? '这个账号池整池暂停，不能单独开'
      : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {index === undefined ? null : (
          <span className="num text-caption text-muted-foreground">{index + 1}.</span>
        )}
        <span className="text-sub font-medium">{name}</span>
        {modelLabel ? <span className="text-caption text-muted-foreground">· {modelLabel}</span> : null}
        <KindChip kind={kind} />
        {r.enabled ? null : (
          <Badge variant="outline" className="h-4 px-1 text-micro font-normal">
            关着
          </Badge>
        )}
        {isFirst ? (
          <Badge variant="secondary" className="h-4 px-1 text-micro font-normal">
            顺位第一条活的
          </Badge>
        ) : null}
        <span className="text-caption text-muted-foreground">
          {routeHost(r)} · <span className="num">{slots.text}</span>
          {slots.full ? <span className="text-ink-stall">（满了，等空位，不算死）</span> : null}
        </span>
        <PoolHoldControl poolId={r.poolId} routeId={r.routeId} />
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
          <span className="num max-w-40 truncate text-micro text-faint" title={r.routeId}>
            {r.routeId}
          </span>
          {channelOff ? (
            <span className="text-caption text-muted-foreground" title="渠道关了，这里不能单独开">
              渠道已关
            </span>
          ) : (
            <RouteSwitch
              label={name}
              enabled={r.enabled}
              lockedWhy={lockWhy}
              onToggle={() =>
                edit.toggleRoute({
                  modelId,
                  modelName,
                  routeId: r.routeId,
                  routeName: name,
                  enabled: r.enabled,
                })
              }
            />
          )}
          {controls}
        </span>
      </div>
      <div className="mt-2 grid gap-x-4 gap-y-2 md:grid-cols-3">
        <Fact label="接得上" fact={r.connect} red={kind === 'fault'}>
          {r.probedAt ? (
            stale ? (
              <span className="text-ink-stall">
                探测过期：{formatAgo(r.probedAt, now)}的结论，探针可能停了
              </span>
            ) : (
              <>{formatAgo(r.probedAt, now)}探的</>
            )
          ) : null}{' '}
          <Link
            to={`/routing/status?p=${encodeURIComponent(r.channelId)}`}
            className="underline underline-offset-2 hover:text-foreground"
          >
            原文、立即探测
          </Link>
        </Fact>
        <Fact label="额度够" fact={r.quota}>
          {r.exhausted.length > 0
            ? r.exhausted.map((w) => (
                <span key={w.label} className="block">
                  {w.label}：{w.resetsAt ? `${formatIn(w.resetsAt, now)}清零` : '清零时刻没读到'}
                </span>
              ))
            : null}
        </Fact>
        <Fact label="禁令与开关" fact={r.ban} />
      </div>
    </>
  );
}

/** 三件事各自的结论词：没过的不叫「死」，只有「接得上」没过、而且整条路由是故障时才画红，额度、禁令没过是暂时挡着。 */
const FACT_WORD = { live: '通过', dead: '没过', unknown: '不知道' } as const;

function Fact({
  label,
  fact,
  red = false,
  children,
}: {
  label: string;
  fact: LivenessFact;
  /** 没过的这件事可以画红（只有故障那条路由的「接得上」）。 */
  red?: boolean;
  children?: ReactNode;
}) {
  const tone: Tone = fact.verdict === 'live' ? 'done' : fact.verdict === 'dead' && red ? 'fail' : 'stall';
  return (
    <div className="min-w-0">
      <div className="text-caption text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-start gap-1.5 text-sub">
        <StatusDot tone={tone} className="mt-1.5" />
        {/* 过了的一件用灰字，没过的（死、不知道）才上色：一眼先看到卡在哪 */}
        <span
          className={cn(
            'min-w-0 break-words',
            fact.verdict === 'live' ? 'text-muted-foreground' : toneText[tone],
          )}
        >
          <span className="sr-only">{FACT_WORD[fact.verdict]}：</span>
          {fact.reason}
        </span>
      </div>
      {children ? <div className="mt-0.5 pl-3.5 text-caption text-muted-foreground">{children}</div> : null}
    </div>
  );
}
