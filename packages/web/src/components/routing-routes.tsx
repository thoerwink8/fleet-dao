// 路由页上「一个模型下的路由」那一块（#574，#1366 第二部分）：每条路由的活 / 死 / 不知道和三件事的原因、开关、整池暂停。
// 用途页（选中一个模型）、模型目录页（选中一个模型）、渠道页（选中一个渠道，看它在各个模型下的路由）共用。
// 改这里之前必须知道：
// - 不知道（探针没看过、额度没读成）不画成活，也不画成死：用停滞色，原因照写。
// - 渠道已关时这条路由不画开关，写「渠道已关」；整池暂停、整池暂停没读成时开关置灰并写原因。

import { type HostId, probeBackoffNotice, routeEffortChoices } from '@fleet-dao/shared';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { usePoolHolds, useRouting } from '../api/client';
import type { LivenessFact, RoutingLayerModel, RoutingLayerRoute } from '../api/types';
import { formatAgo, formatIn } from '../lib/format';
import { useMediaQuery } from '../lib/hooks';
import { poolIsHeld } from '../lib/pool-holds';
import { routeKind } from '../lib/route-kinds';
import { probeStale, routeHost, routeSlots, routeTitle } from '../lib/routing';
import { supportedPurposeEfforts } from '../lib/routing-browse';
import { actualRanks, routeSlotState, type SlotState, slotWord, summarizeOrder } from '../lib/routing-order';
import { type Tone, toneText } from '../lib/status';
import { cn } from '../lib/utils';
import { PoolProblemLine, usePoolProblems } from './pool-problem';
import {
  COMPACT_MQ,
  RouteSwitch,
  type RowControls,
  RowMenu,
  SortableList,
  useRoutingEdit,
} from './routing-edit';
import { PoolHoldControl } from './routing-hold';
import { KindChip, useKindEnv } from './routing-kinds';
import { StatusDot } from './status';
import { Badge } from './ui/badge';

/**
 * 档位配不了时的长说明（「没有单独的档位参数……不带方括号」等）：行内不铺开，
 * 悬停看全文（#1754）。和 membership 里下拉置灰用的同一句话。
 */
export function effortBlockedTitle(
  modelId: string,
  routes: readonly { hostId: HostId; upstreamModel?: string | undefined }[],
): string | undefined {
  // 和 membership 的 effortBlockedWhy 同一套话：先看有没有共同认的档，没有再取 fixed 原因。
  if (supportedPurposeEfforts(modelId, routes).length > 0) return undefined;
  for (const route of routes) {
    const choices = routeEffortChoices(route.hostId, modelId);
    if (choices.kind === 'fixed') return choices.why;
  }
  if (routes.length === 0) return '一条路由都没有，没有能配的档位';
  return '这几条路由没有共同认的档位';
}

/**
 * 套在模型行外层：把 membership 写在行内的 data-row-note 藏掉；
 * 全文改由 ModelRow 操作区的 title={effortBlockedTitle(...)} 悬停给出。
 */
export const hideEffortRowNoteClass = '[&_[data-row-note]]:hidden';

/**
 * 模型已关时：路由列表默认折叠，头上保留配置顺序号和「已关 N 条路由」；点开展开（#1754）。
 * 开着的模型不走这层，直接画 ModelRoutes。
 */
export function CollapsibleOffModelRoutes({
  model,
  position,
  now,
  firstLiveRoute,
}: {
  model: RoutingLayerModel;
  /** 配置里的先后（从 1 起），折叠头上照写，不改号。 */
  position: number;
  now: number;
  firstLiveRoute?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const n = model.routes.length;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`off-routes-${model.modelId}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sub hover:bg-muted/50"
      >
        <ChevronRight
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        <span data-position className="num shrink-0 text-muted-foreground">
          {position}
        </span>
        <span>
          已关 <span className="num">{n}</span> 条路由
        </span>
      </button>
      <div id={`off-routes-${model.modelId}`} hidden={!open}>
        {open ? <ModelRoutes model={model} now={now} firstLiveRoute={firstLiveRoute} /> : null}
      </div>
    </>
  );
}

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
  const env = useKindEnv();
  if (m.routes.length === 0) {
    return <p className="px-3 py-2.5 text-sub text-ink-fail">这个模型下一条路由都没有：排了它也派不到它</p>;
  }
  // 引擎自动跳过关着的、顺延给下一个：实际顺位只数开着的（lib/routing-order.ts）
  const states = m.routes.map((r) => routeSlotState(r, env.channelEnabled));
  const ranks = actualRanks(states);
  const slotOf = new Map(
    m.routes.map((r, i) => [r.routeId, { state: states[i] ?? 'on', rank: ranks[i] ?? null }]),
  );
  const summary = summarizeOrder(states, '路由');
  return (
    <>
      <OrderSummaryLine summary={summary} noun="路由" />
      <SortableList
        ariaLabel={`${m.displayName} 的路由`}
        items={m.routes}
        itemId={(r) => r.routeId}
        itemLabel={(r) => `${routeTitle(r)}（${m.displayName} 下的先后）`}
        disabled={edit.disabledWhy !== null}
        busy={edit.busy}
        disabledWhy={edit.disabledWhy}
        rowClassName={(r) =>
          cn('border-b px-3 py-1.5 last:border-b-0', slotOf.get(r.routeId)?.state !== 'on' && 'bg-muted/40')
        }
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
            rowControls={controls}
            now={now}
            firstLive={r.routeId === firstLiveRoute}
            {...(slotOf.has(r.routeId) ? { slot: slotOf.get(r.routeId) } : {})}
          />
        )}
      </SortableList>
    </>
  );
}

/** 这一层引擎实际会派几个、跳过几个；一个都派不了明说「无可用」，不画成没事。 */
export function OrderSummaryLine({
  summary,
  noun,
}: {
  summary: ReturnType<typeof summarizeOrder>;
  noun: '模型' | '路由';
}) {
  return (
    <p
      role="status"
      data-order-summary={summary.ok ? 'ok' : 'none'}
      className={cn(
        'border-b px-3 py-1.5 text-caption',
        summary.ok ? 'text-muted-foreground' : 'bg-st-fail/10 text-ink-fail',
      )}
    >
      {summary.ok
        ? `引擎按这个先后试：开着的 ${summary.active} 个${noun}，${
            summary.skipped > 0
              ? `跳过 ${summary.skipped} 个（${
                  noun === '模型' ? '关着、已下架或没有可用路由' : '关着、疑似降智或没有可用路由'
                }），`
              : ''
          }排头的是配置里第 ${summary.firstPosition} 个`
        : summary.why}
    </p>
  );
}

export function RouteItem({
  route: r,
  index,
  modelId,
  modelName,
  modelLabel,
  controls,
  rowControls,
  now,
  firstLive: isFirst,
  slot,
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
  /** 手机上把开关和先后收进「⋯」菜单用；给了 controls 的调用方一起给。 */
  rowControls?: RowControls;
  now: number;
  firstLive?: boolean;
  /** 在顺序里的实际顺位和是否被跳过（lib/routing-order.ts）；不给就不写（渠道页里的路由不分先后）。 */
  slot?: { state: SlotState; rank: number | null } | undefined;
}) {
  const [open, setOpen] = useState(false);
  // 不到 lg 且这一行能调先后（模型下的路由）：操作收进「⋯」菜单。渠道页里的路由只有一个开关，不收。
  const menuMode = useMediaQuery(COMPACT_MQ) && rowControls !== undefined;
  const stale = probeStale(r, now);
  const backoff = probeBackoffNotice(r.probeDetail ?? r.connect.reason);
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
  const poolProblem = usePoolProblems().problems.get(r.poolId);
  const poolLocked = Boolean(holds.data && poolIsHeld(holds.data, r.poolId));
  const lockWhy = holds.error
    ? '整池暂停没读成，先不能开这条路由'
    : poolLocked
      ? '这个账号池整池暂停，不能单独开'
      : null;
  return (
    <>
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 md:min-h-9">
        {index === undefined ? null : (
          <span className="num w-5 shrink-0 text-caption text-muted-foreground">{index + 1}.</span>
        )}
        <span className={cn('text-sub font-medium', slot && slot.state !== 'on' && 'text-muted-foreground')}>
          {name}
        </span>
        {modelLabel ? <span className="text-caption text-muted-foreground">· {modelLabel}</span> : null}
        {slot ? (
          <span
            data-slot-state={slot.state}
            className={cn(
              'text-caption',
              slot.state === 'on'
                ? 'num text-muted-foreground'
                : 'rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground',
            )}
          >
            {slotWord(slot.state, slot.rank, '路由')}
          </span>
        ) : null}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1">
          {channelOff ? (
            <span className="text-caption text-muted-foreground" title="渠道关了，这里不能单独开">
              渠道已关
            </span>
          ) : menuMode ? null : (
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
          {menuMode && rowControls ? (
            // 手机：开关和上移、下移、置顶、置底收进「⋯」菜单（#1806），一行不再挤一排小按钮
            <RowMenu
              moves={rowControls.moves}
              leading={
                channelOff
                  ? []
                  : [
                      {
                        key: 'toggle',
                        label: r.enabled ? '关闭这条路由' : '开启这条路由',
                        disabled: (edit.disabledWhy ?? lockWhy) !== null,
                        title: edit.disabledWhy ?? lockWhy ?? undefined,
                        onSelect: () =>
                          edit.toggleRoute({
                            modelId,
                            modelName,
                            routeId: r.routeId,
                            routeName: name,
                            enabled: r.enabled,
                          }),
                      },
                    ]
              }
            />
          ) : (
            controls
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`facts-${r.routeId}`}
            aria-label={`${open ? '收起' : '展开'} ${name} 的接得上、额度、禁令`}
            title="接得上、额度够、禁令与开关三件事的原因"
            onClick={() => setOpen((v) => !v)}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground min-h-9 min-w-9 md:min-h-0 md:min-w-0"
          >
            <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} aria-hidden />
          </button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1 pl-0 md:pl-7">
        <KindChip kind={kind} />
        {r.enabled || slot ? null : (
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
          {slots.full ? <span className="text-ink-stall">（满了，等空位，不算故障）</span> : null}
        </span>
        <PoolHoldControl poolId={r.poolId} routeId={r.routeId} />
        <span className="num max-w-40 truncate text-micro text-faint" title={r.routeId}>
          {r.routeId}
        </span>
        {backoff ? (
          <span data-probe-backoff className="basis-full text-caption text-ink-stall">
            {backoff}
          </span>
        ) : null}
        {poolProblem ? <PoolProblemLine problem={poolProblem} now={now} className="basis-full" /> : null}
      </div>
      <div
        id={`facts-${r.routeId}`}
        hidden={!open}
        className="mt-1 mb-1 grid gap-x-4 gap-y-2 rounded-md bg-muted/30 p-2 md:grid-cols-3"
      >
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
