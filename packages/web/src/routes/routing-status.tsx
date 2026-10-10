// 渠道状态页（#1087；近 60 次真历史 #1139；重做 #1366）：左边一列折叠的渠道摘要行，右边（手机上是整页）点开的渠道详情。
// 默认全部折叠：一行只写名字、状态、几条在线/故障/已关、最近一次探测。故障的渠道置顶；顶上有搜索和状态筛选。
// 详情里才有每条路由（手风琴，一次只开一条）、原文、立即探测；再下面是「探测记录」（components/probe-log.tsx，#1638）：
// 每一次探测一行，新的在上，点一行（或点上面的格子）展开请求、响应原文。
// 改这里之前必须知道：
// - 通不通、排第几、运行中失败、检测中断都在 lib/channel-status.ts 判，和路由页顶上那一行同一份；这里只画。
// - 状态种类（在线、故障、已关、未被用途使用、池暂停、已下架、未探）在 lib/route-state.ts：只有「该在线却探不通」才是故障、画红。
//   人关的、没用途在用的、整池暂停的不是坏了，也不进「故障」的数。
// - 「立即探测」点下去由法国引擎接手（engine/src/jobs/route-probe-now.ts），走到哪由后端从操作记录现算；页面在探的时候
//   每 3 秒重拉一次，探完自己把路由目录也重拉（api/client.tsx 的 useRouteProbeStatus）。
// - 探不了要说清是哪样：引擎关着、没连上、没查成、没人接手、引擎说没探成，各有一句，不显示成「通」或空白。
// - 近 60 次来自探针历史（route_probe_history），本渠道所有路由按时间排，一次一格。没探和不通颜色分开。
//   均耗时、可用率按这 60 格算。库读不到写「没查成」，不拿空格子冒充没有。引擎关着这一份照样读。

import { PROBE_HISTORY_SLOTS, probeBackoffNotice, probeNextEveryMinutes } from '@fleet-dao/shared';
import { ArrowLeft, ChevronDown, LoaderCircle, Radar, SatelliteDish } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { brand } from '#brand';
import {
  errorText,
  usePoolHolds,
  useProbeHistory,
  useRouteProbeNow,
  useRouteProbeStatus,
  useRouting,
  useRoutingLayers,
} from '../api/client';
import type {
  Model,
  ProbeHistoryCell,
  Route,
  RouteProbeHistory,
  RouteProbeRequest,
  RouteProbeStatus,
} from '../api/types';
import {
  ChannelFilterBar,
  type ChannelHistory,
  ChannelList,
  FailoverNote,
  HistoryStrip,
} from '../components/channel-status';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { ProbeLog } from '../components/probe-log';
import { RefreshBar } from '../components/refresh-bar';
import { StatusChip, StatusDot } from '../components/status';
import { Button } from '../components/ui/button';
import {
  buildChannelCards,
  type ChannelCard,
  channelMatchesFilter,
  channelProbeInterrupted,
  routeKindMap,
} from '../lib/channel-status';
import { formatAgo, formatClock, formatIn, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { poolIsHeld } from '../lib/pool-holds';
import {
  activeFor,
  activityText,
  isActive,
  lastFailureFor,
  probeSeconds,
  sourceText,
} from '../lib/route-probe';
import {
  type RouteStateKind,
  routeStateLabel,
  routeStateTone,
  routeStateWhy,
  STATE_FILTERS,
  type StateFilter,
} from '../lib/route-state';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('渠道状态') }];
}

const DESCRIPTION =
  '每个渠道通不通、不通为什么。点「立即探测」让法国引擎现在就探，不用等下一轮（Claude 订阅 15 分钟一轮；Mirasim、Cursor、Grok 探通后 2 小时一轮）。';

/** 渠道目录每 30 秒自己重拉。超过 5 分钟还没再读成，刷新条才标「数据已过期」。 */
const ROUTING_STATUS_STALE_AFTER_MS = 5 * TIME.MIN;

const STATE_WORD: Record<NonNullable<Route['probe']>['state'], { label: string; tone: Tone }> = {
  ok: { label: '通过', tone: 'done' },
  failed: { label: '不通', tone: 'fail' },
  skipped: { label: '没探', tone: 'stall' },
  not_wired: { label: '插头没接', tone: 'stall' },
};

/** 引擎此刻能不能接立即探测：不能就一句话说清是哪样，按钮跟着置灰。 */
function engineBlock(status: RouteProbeStatus | undefined, error: unknown): string | undefined {
  if (error) return `立即探测的记录没读成：${errorText(error)}`;
  if (!status) return '正在读引擎在不在';
  const e = status.engine;
  const detail = e.detail ? `（${e.detail}）` : '';
  if (e.state === 'on') return undefined;
  if (e.state === 'off') return `引擎按配置没开${detail}：探不了`;
  if (e.state === 'down') return `引擎没连上${detail}：探不了，等它起来`;
  return `没查成引擎在不在${detail}：探不了`;
}

function toHistory(data: RouteProbeHistory | undefined, error: unknown): ChannelHistory {
  if (!data) {
    if (error) return { state: 'unreadable', why: `没查成：${errorText(error)}` };
    return { state: 'loading' };
  }
  if (data.state === 'unreadable') return { state: 'unreadable', why: data.why };
  return { state: 'ok', channels: data.channels, latestByRoute: data.latestByRoute };
}

/** 右边正在看的那一次。点格子优先；点路由行看它自己的最近一次（挤出 60 格也算）；都没点就看这条带里最新的一格。 */
function resolveProbe(
  channelId: string,
  view: ChannelHistory,
  cellPick: { channelId: string; cellId: number } | null,
  routePick: { channelId: string; routeId: string } | null,
): { cell: ProbeHistoryCell | undefined; routeMissing: boolean } {
  if (view.state !== 'ok') return { cell: undefined, routeMissing: false };
  const strip = view.channels.find((item) => item.channelId === channelId);
  const cells = (strip?.cells ?? []).slice(-PROBE_HISTORY_SLOTS);
  if (cellPick?.channelId === channelId) {
    const cell =
      cells.find((item) => item.id === cellPick.cellId) ??
      view.latestByRoute.find((item) => item.id === cellPick.cellId && item.channelId === channelId);
    return { cell, routeMissing: false };
  }
  if (routePick?.channelId === channelId) {
    const cell = view.latestByRoute.find(
      (item) => item.routeId === routePick.routeId && item.channelId === channelId,
    );
    return { cell, routeMissing: cell === undefined };
  }
  // 什么都没点：探测记录都折叠着，不替人选
  return { cell: undefined, routeMissing: false };
}

export default function RoutingStatus() {
  const routing = useRouting();
  const layers = useRoutingLayers();
  const probe = useRouteProbeStatus();
  const historyQuery = useProbeHistory();
  const probeNow = useRouteProbeNow();
  const holds = usePoolHolds();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const [manualPick, setManualPick] = useState<string | null>(null);
  const [cellPick, setCellPick] = useState<{ channelId: string; cellId: number } | null>(null);
  const [routePick, setRoutePick] = useState<{ channelId: string; routeId: string } | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');
  // 窄屏上列表和详情是两页：点一行进详情，点「返回」回列表（宽屏两栏并排，不看它）
  const [detailOpen, setDetailOpen] = useState(() => params.has('p'));

  const poolHeld = useMemo(
    () => (poolId: string) => (holds.data ? poolIsHeld(holds.data, poolId) : false),
    [holds.data],
  );
  const cards = useMemo(
    () => (routing.data && layers.data ? buildChannelCards(routing.data, layers.data, now, poolHeld) : []),
    [routing.data, layers.data, now, poolHeld],
  );
  const kinds = useMemo(
    () => (routing.data && layers.data ? routeKindMap(routing.data, layers.data, now, poolHeld) : new Map()),
    [routing.data, layers.data, now, poolHeld],
  );
  // 搜索只在渠道名、渠道号、渠道下的路由号和模型名里找
  const haystack = useMemo(() => {
    const out = new Map<string, string>();
    if (!routing.data) return out;
    const modelName = new Map(routing.data.models.map((m) => [m.id, m.displayName]));
    for (const c of routing.data.channels) {
      const mine = routing.data.routes.filter((r) => r.channelId === c.id);
      out.set(
        c.id,
        [c.name, c.id, ...mine.flatMap((r) => [r.id, r.modelId, modelName.get(r.modelId) ?? ''])]
          .join('\n')
          .toLowerCase(),
      );
    }
    return out;
  }, [routing.data]);

  const requests = probe.data?.requests ?? [];
  const blocked = engineBlock(probe.data, probe.error);
  const history = toHistory(historyQuery.data, historyQuery.error);

  if (routing.error || layers.error) {
    return (
      <Page title="渠道状态" description={DESCRIPTION}>
        {routing.error ? <LoadError what="渠道目录" error={routing.error} /> : null}
        {layers.error ? <LoadError what="路由两层" error={layers.error} /> : null}
      </Page>
    );
  }
  if (!routing.data || !layers.data) {
    return (
      <Page title="渠道状态" description={DESCRIPTION}>
        <LoadingRows rows={5} />
      </Page>
    );
  }
  if (cards.length === 0) {
    return (
      <Page title="渠道状态" description={DESCRIPTION}>
        <Panel>
          <Empty icon={SatelliteDish} title="目录里一个渠道都没有" hint="渠道在库里没配上：去看后端日志" />
        </Panel>
      </Page>
    );
  }

  const q = search.trim().toLowerCase();
  const filterCounts = Object.fromEntries(
    STATE_FILTERS.map((f) => [f.id, cards.filter((c) => channelMatchesFilter(c, f.id)).length]),
  ) as Record<StateFilter, number>;
  // 故障的置顶，其余照顺位；Array.sort 是稳定的
  const visible = cards
    .filter((c) => channelMatchesFilter(c, filter) && (q === '' || haystack.get(c.channel.id)?.includes(q)))
    .sort((a, b) => Number(b.hasFault && !b.interrupted) - Number(a.hasFault && !a.interrupted));

  // 只在筛选结果里选：原来的还在结果里就留着，不在就改看结果的第一个。
  // 一个都不符合就空着，不退回全部渠道的第一个——否则左边写没搜到，右边还像搜到了。
  const wanted = manualPick ?? params.get('p');
  const stillThere = wanted !== null && visible.some((c) => c.channel.id === wanted);
  const picked = visible.length === 0 ? undefined : stillThere ? wanted : visible[0]?.channel.id;
  const current = picked ? cards.find((c) => c.channel.id === picked) : undefined;
  const focus = current ? resolveProbe(current.channel.id, history, cellPick, routePick) : undefined;
  const pickChannel = (id: string) => {
    setManualPick(id);
    setCellPick(null);
    setRoutePick(null);
    setDetailOpen(true);
    setParams({ p: id }, { replace: true, preventScrollReset: true });
  };
  const pickCell = (channelId: string, cellId: number) => {
    setManualPick(channelId);
    setCellPick({ channelId, cellId });
    setRoutePick(null);
    setParams({ p: channelId }, { replace: true, preventScrollReset: true });
  };
  const allRoutes = routing.data.routes;
  const probing = new Set(allRoutes.filter((r) => activeFor(requests, r.id)).map((r) => r.channelId));
  // 三样分开数：在线、故障（该修）、待查（还没探到、按量不探、检测中断）；已关、未被用途使用另数，不算坏
  const open = cards.filter((c) => c.state !== 'off' && c.state !== 'idle');
  const okCount = open.filter((c) => (c.state === 'ok' || c.state === 'partial') && !c.interrupted).length;
  const downCount = open.filter((c) => c.state === 'down' && !c.interrupted).length;
  const unknownCount = open.length - okCount - downCount;
  const quietCount = cards.length - open.length;
  const allActive = requests.some((r) => isActive(r) && r.routeIds === undefined);
  const fire = (routeIds?: string[]) => probeNow.mutate(routeIds ? { routeIds } : {});

  return (
    <Page
      title="渠道状态"
      description={DESCRIPTION}
      actions={
        <>
          <StatusChip tone="done" label={`${okCount} 个在线`} />
          {downCount > 0 ? <StatusChip tone="fail" label={`${downCount} 个故障`} /> : null}
          {unknownCount > 0 ? <StatusChip tone="stall" label={`${unknownCount} 个待查`} /> : null}
          {quietCount > 0 ? <StatusChip tone="stop" label={`${quietCount} 个已关或未使用`} /> : null}
          <RefreshBar
            onRefresh={() => void routing.refetch()}
            isFetching={routing.isFetching}
            // 共用秒表一拍最多慢 1 秒。刚读成的时间戳比「现在」新时压回这一拍，避免显示成「1 秒后」。
            dataUpdatedAt={routing.dataUpdatedAt > now ? now : routing.dataUpdatedAt}
            staleAfterMs={ROUTING_STATUS_STALE_AFTER_MS}
          />
          <Button
            size="sm"
            onClick={() => fire()}
            disabled={blocked !== undefined || allActive || probeNow.isPending}
            title={blocked ?? (allActive ? '全部路由正在探' : '让引擎现在就把全部路由探一遍')}
          >
            {allActive || probeNow.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : (
              <Radar aria-hidden />
            )}
            全部立即探测
          </Button>
        </>
      }
    >
      <ProbeBanner
        requests={requests}
        now={now}
        blocked={blocked}
        error={probeNow.error}
        onDismissError={() => probeNow.reset()}
      />
      <div className="grid items-start gap-4 xl:grid-cols-routing">
        <div className={cn('min-w-0', detailOpen && 'hidden xl:block')}>
          <ChannelFilterBar
            search={search}
            onSearch={setSearch}
            filter={filter}
            onFilter={setFilter}
            counts={filterCounts}
          />
          {visible.length === 0 ? (
            <p
              role="status"
              className="rounded-lg border border-dashed px-3 py-6 text-center text-sub text-muted-foreground"
            >
              没有符合的渠道{q ? `：「${search.trim()}」` : ''}
              {filter !== 'all' ? `，筛选在「${STATE_FILTERS.find((f) => f.id === filter)?.label}」` : ''}
            </p>
          ) : (
            // 桌面下列表最高换成 max-h-routing-pane。
            <div className="xl:max-h-routing-pane xl:overflow-y-auto xl:pr-1">
              <ChannelList
                cards={visible}
                selected={picked ?? undefined}
                probing={probing}
                now={now}
                onPick={pickChannel}
              />
            </div>
          )}
          <ul className="mt-3 space-y-1 text-caption text-muted-foreground">
            <li>绿灯只表示本节点最近一轮抽测通过，不保证每次使用都正常。</li>
            <li>上次探测超过「探测间隔 + 3 分钟」还没更新，就显示「检测中断」，不拿旧绿灯掩盖中断。</li>
            <li>已关（人关的）、未被用途使用、池暂停、已下架都不是坏了，只有「故障」才要修。</li>
            <li>
              每个用途排哪些模型、能不能派，看{' '}
              <Link to="/routing" className="underline underline-offset-2">
                路由
              </Link>
              。
            </li>
          </ul>
        </div>
        <div className={cn('min-w-0', !detailOpen && 'hidden xl:block')}>
          {current ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="mb-2 xl:hidden"
                onClick={() => setDetailOpen(false)}
              >
                <ArrowLeft aria-hidden />
                返回渠道列表
              </Button>
              <ChannelDetail
                key={current.channel.id}
                card={current}
                routes={allRoutes.filter((r) => r.channelId === current.channel.id)}
                models={routing.data.models}
                kinds={kinds}
                requests={requests}
                blocked={blocked}
                busy={probeNow.isPending}
                now={now}
                history={history}
                focus={focus}
                onPickCell={(cellId) => pickCell(current.channel.id, cellId)}
                onPickRoute={(routeId) => {
                  setRoutePick({ channelId: current.channel.id, routeId });
                  setCellPick(null);
                }}
                onProbe={fire}
              />
            </>
          ) : (
            <p
              role="status"
              className="rounded-lg border border-dashed px-3 py-6 text-center text-sub text-muted-foreground"
            >
              没有可看的渠道，换个搜索词或筛选
            </p>
          )}
        </div>
      </div>
    </Page>
  );
}

/** 顶上一条：在探的走到哪、刚探完的结果、点了没成的原因、探不了的原因。都没有就不占地方。 */
function ProbeBanner({
  requests,
  now,
  blocked,
  error,
  onDismissError,
}: {
  requests: readonly RouteProbeRequest[];
  now: number;
  blocked: string | undefined;
  error: unknown;
  onDismissError: () => void;
}) {
  const active = requests.filter(isActive);
  const last = requests.find((r) => !isActive(r));
  const recent =
    last && now - Date.parse(last.finishedAt ?? last.requestedAt) < 30 * 60_000 ? last : undefined;
  const lines: { key: string; tone: Tone; text: string; spin?: boolean; onClose?: () => void }[] = [];
  if (error) {
    lines.push({ key: 'error', tone: 'fail', text: `没探成：${errorText(error)}`, onClose: onDismissError });
  }
  if (blocked && !error) lines.push({ key: 'blocked', tone: 'stall', text: blocked });
  for (const r of active) {
    const what = r.routeIds ? `${r.routeIds.length} 条路由` : '全部路由';
    lines.push({
      key: r.requestId,
      tone: r.why ? 'stall' : 'run',
      text: `正在探${what}：${activityText(r, now)}`,
      spin: true,
    });
  }
  if (recent) {
    const at = formatClock(recent.finishedAt ?? recent.requestedAt);
    const from = sourceText(recent);
    const label = from ? `${from}，` : '立即探测';
    if (recent.state === 'done') {
      const count = (o: string[]) => recent.results.filter((x) => o.includes(x.outcome)).length;
      lines.push({
        key: recent.requestId,
        tone: count(['failed']) > 0 ? 'fail' : 'done',
        text: `${at} 的${label}探完了：通过 ${count(['ok'])} · 不通 ${count(['failed'])} · 没探 ${count([
          'skipped',
          'not_wired',
          'unsettled',
          'gone',
        ])}（按量计费、下架、没用途在用的照规矩不探，原因写在每条路由上）`,
      });
    } else {
      lines.push({
        key: recent.requestId,
        tone: 'fail',
        text: `${at} 的${label}没成：${recent.why ?? '没写原因'}`,
      });
    }
  }
  if (lines.length === 0) return null;
  return (
    <ul aria-label="立即探测" className="mb-4 space-y-1.5">
      {lines.map((l) => (
        <li
          key={l.key}
          role={l.tone === 'fail' ? 'alert' : 'status'}
          className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-2 text-sub',
            l.tone === 'fail' && 'border-st-fail/40 bg-st-fail/10 text-ink-fail',
            l.tone === 'stall' && 'border-st-stall/50 bg-st-stall/10 text-ink-stall',
            l.tone === 'run' && 'border-st-run/40 bg-st-run/10 text-ink-run',
            l.tone === 'done' && 'bg-card text-muted-foreground',
          )}
        >
          {l.spin ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden /> : null}
          <span className="min-w-0 flex-1 break-words">{l.text}</span>
          {l.onClose ? (
            <button type="button" onClick={l.onClose} className="text-caption underline underline-offset-2">
              知道了
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** 路由行的先后：该修的在前，要看一眼的其次，在线的，最后是已关、没用的。同一档里探过的在前、再按编号。 */
const KIND_ORDER: readonly RouteStateKind[] = [
  'fault',
  'blocked',
  'unknown',
  'unprobed',
  'live',
  'held',
  'off',
  'retired',
  'unused',
];

function ChannelDetail({
  card,
  routes,
  models,
  kinds,
  requests,
  blocked,
  busy,
  now,
  history,
  focus,
  onPickCell,
  onPickRoute,
  onProbe,
}: {
  card: ChannelCard;
  routes: readonly Route[];
  models: readonly Model[];
  kinds: ReadonlyMap<string, RouteStateKind>;
  requests: readonly RouteProbeRequest[];
  blocked: string | undefined;
  busy: boolean;
  now: number;
  history: ChannelHistory;
  focus: { cell: ProbeHistoryCell | undefined; routeMissing: boolean } | undefined;
  onPickCell: (cellId: number) => void;
  onPickRoute: (routeId: string) => void;
  onProbe: (routeIds: string[]) => void;
}) {
  // 手风琴：一次只展开一条路由
  const [openRoute, setOpenRoute] = useState<string | null>(null);
  // 探测记录里展开哪一行：页面选中的那一格（点格子、点「看最近一次」）就是展开的那行；点开着的那行再点一下折起来
  const [dismissed, setDismissed] = useState<number | null>(null);
  const focusId = focus?.cell?.id;
  const openId = focusId !== undefined && focusId !== dismissed ? focusId : undefined;
  const pickCell = (cellId: number) => {
    setDismissed(null);
    onPickCell(cellId);
  };
  const toggleCell = (cellId: number) => {
    if (cellId === openId) setDismissed(cellId);
    else pickCell(cellId);
  };
  const kindOf = (r: Route): RouteStateKind => kinds.get(r.id) ?? 'unused';
  const sorted = [...routes].sort(
    (a, b) =>
      KIND_ORDER.indexOf(kindOf(a)) - KIND_ORDER.indexOf(kindOf(b)) ||
      (a.probe ? 0 : 1) - (b.probe ? 0 : 1) ||
      a.id.localeCompare(b.id),
  );
  const idle = sorted.filter((r) => !activeFor(requests, r.id)).map((r) => r.id);
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-x-2">
          {card.channel.name}
          <span className="text-caption font-normal text-muted-foreground">
            {card.channel.billing === 'metered' ? '按量计费' : '订阅'} · {routes.length} 条路由
          </span>
        </span>
      }
      description={card.reason && !card.failover ? card.reason : undefined}
      actions={
        <div className="flex items-center gap-2">
          <StatusChip tone={card.tone} label={card.label} />
          <Button
            size="sm"
            variant="outline"
            disabled={blocked !== undefined || idle.length === 0 || busy}
            title={
              blocked ?? (idle.length === 0 ? '这个渠道的路由都在探' : '让引擎现在就探这个渠道的每条路由')
            }
            onClick={() => onProbe(idle)}
          >
            <Radar aria-hidden />
            探这个渠道
          </Button>
        </div>
      }
    >
      {card.interrupted ? (
        <p role="status" className="mb-3 text-sub font-medium text-ink-stall">
          检测中断：探针超过间隔没更新这个渠道，上次的结论不再当现状
          {card.probedAt ? `（${formatAgo(card.probedAt, now)}）` : null}
        </p>
      ) : null}
      {card.fallback ? <p className="mb-3 text-sub text-ink-fail">{card.fallback}</p> : null}
      {card.failover ? <FailoverNote failover={card.failover} now={now} /> : null}
      <HistoryStrip
        channelId={card.channel.id}
        history={history}
        activeCellId={focus?.cell?.id}
        onPickCell={(channelId, cellId) => {
          if (channelId === card.channel.id) pickCell(cellId);
        }}
      />
      <ProbeLog
        history={history}
        channelId={card.channel.id}
        routes={routes}
        models={models}
        openId={openId}
        routeMissing={focus?.routeMissing ?? false}
        onToggle={toggleCell}
      />
      {sorted.length === 0 ? (
        <p className="text-sub text-muted-foreground">这个渠道下一条路由都没有。</p>
      ) : (
        <ol aria-label={`${card.channel.name} 的路由`} className="space-y-1.5">
          {sorted.map((r) => (
            <RouteRow
              key={r.id}
              route={r}
              kind={kindOf(r)}
              model={models.find((m) => m.id === r.modelId)}
              requests={requests}
              blocked={blocked}
              busy={busy}
              now={now}
              open={openRoute === r.id}
              picked={focus?.cell?.routeId === r.id}
              onToggle={() => setOpenRoute((cur) => (cur === r.id ? null : r.id))}
              onPick={() => {
                setDismissed(null);
                onPickRoute(r.id);
              }}
              onProbe={() => onProbe([r.id])}
            />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function RouteRow({
  route: r,
  kind,
  model,
  requests,
  blocked,
  busy,
  now,
  open,
  picked,
  onToggle,
  onPick,
  onProbe,
}: {
  route: Route;
  kind: RouteStateKind;
  model: Model | undefined;
  requests: readonly RouteProbeRequest[];
  blocked: string | undefined;
  busy: boolean;
  now: number;
  open: boolean;
  picked: boolean;
  onToggle: () => void;
  onPick: () => void;
  onProbe: () => void;
}) {
  const active = activeFor(requests, r.id);
  const failure = lastFailureFor(requests, r);
  const probe = r.probe;
  const word = probe ? STATE_WORD[probe.state] : { label: '还没探到', tone: 'stop' as Tone };
  const notice = probe ? probeBackoffNotice(probe.detail) : null;
  const stale = probe
    ? channelProbeInterrupted(
        {
          probedAt: probe.at,
          hostId: r.hostId,
          ...(probe.detail !== undefined ? { detail: probe.detail } : {}),
        },
        now,
      )
    : false;
  const seconds = probeSeconds(r, requests);
  const every = probeNextEveryMinutes(r.hostId, probe?.state, probe?.detail);
  const nextAt = probe ? new Date(Date.parse(probe.at) + every * 60_000).toISOString() : undefined;
  const name = model?.displayName ?? r.modelId;
  const bodyId = `route-body-${r.id}`;
  const failed = kind === 'fault';
  return (
    <li
      data-route={r.id}
      data-probe={active ? active.state : (probe?.state ?? 'none')}
      data-kind={kind}
      className={cn(
        'rounded-lg border',
        failed && !active && 'border-st-fail/40',
        (kind === 'off' || kind === 'unused' || kind === 'retired') && 'bg-muted/30',
        picked && 'ring-2 ring-ring/40',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`${name} ${r.id}：${active ? (active.state === 'running' ? '探测中' : '排队中') : routeStateLabel[kind]}`}
        className="flex min-h-10 w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <StatusDot tone={active ? 'run' : routeStateTone[kind]} />
        <span className="shrink-0 text-sm font-semibold">{name}</span>
        <span className="num min-w-0 flex-1 truncate text-caption text-muted-foreground" title={r.id}>
          {r.id}
        </span>
        {active ? (
          // 探测中换成 text-caption。
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-st-run/10 px-1.5 text-caption font-medium leading-5 text-ink-run">
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
            {active.state === 'running' ? '探测中' : '排队中'}
          </span>
        ) : (
          <StatusChip tone={routeStateTone[kind]} label={routeStateLabel[kind]} />
        )}
        {kind === 'unused' && !active && (probe?.state === 'ok' || probe?.state === 'failed') ? (
          // 没用途在用的路由点立即探测（#1630）：灰的「未被用途使用」不变，结论在旁边写出来，不画红
          <StatusChip
            tone={probe.state === 'ok' ? 'done' : 'stall'}
            label={probe.state === 'ok' ? '探过：通' : '探过：不通'}
          />
        ) : null}
        {stale && !active && kind !== 'unused' ? <StatusChip tone="stall" label="结论过期" /> : null}
        <span className="num hidden shrink-0 text-caption text-muted-foreground sm:inline">
          {probe ? formatAgo(probe.at, now) : ''}
        </span>
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {notice && !active ? (
        <p data-probe-backoff className="px-3 pb-1.5 text-caption text-ink-stall">
          {notice}
        </p>
      ) : null}
      {failed && probe?.detail && !open ? (
        <p className="truncate px-3 pb-2 text-caption text-ink-fail" title={probe.detail}>
          {probe.detail}
        </p>
      ) : null}
      {open ? (
        <div id={bodyId} className="border-t px-3 pb-3 pt-2.5">
          <p className="mb-2 text-caption text-muted-foreground">{routeStateWhy[kind]}</p>
          {active ? (
            <p className={cn('mb-2 text-caption', active.why ? 'text-ink-stall' : 'text-ink-run')}>
              {activityText(active, now)}
            </p>
          ) : null}
          {failure ? (
            <p role="alert" className="mb-2 text-caption text-ink-fail">
              {formatClock(failure.requestedAt)} {sourceText(failure) ?? '点的立即探测'}没成：
              {failure.why ?? '没写原因'}
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-caption sm:grid-cols-4">
            <Fact label="探针结论">{word.label}</Fact>
            <Fact label="最近一次">
              {probe ? (
                <span className="num">
                  {formatClock(probe.at)}（{formatAgo(probe.at, now)}）
                </span>
              ) : (
                '探针还没看过'
              )}
            </Fact>
            <Fact label="耗时">
              {seconds !== undefined ? (
                <span className="num">{seconds.toFixed(seconds < 10 ? 1 : 0)} 秒</span>
              ) : (
                <span className="text-muted-foreground">
                  {probe && probe.state !== 'ok' && probe.state !== 'failed' ? '没真探' : '没量到'}
                </span>
              )}
            </Fact>
            <Fact label="执行方式">{r.hostId}</Fact>
            <Fact label="下一轮定时探">
              {nextAt ? <span className="num">{formatIn(nextAt, now)}</span> : '上线后第一轮'}
            </Fact>
          </dl>
          <div className="mt-2.5">
            <div className="mb-1 text-caption text-muted-foreground">
              {probe?.state === 'failed' ? '失败原因（原文）' : '原文'}
            </div>
            <pre
              className={cn(
                'max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-micro',
                failed ? 'text-ink-fail' : 'text-muted-foreground',
              )}
            >
              {probe ? (probe.detail ?? '（探针没写原文）') : '（还没有结论）'}
            </pre>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={blocked !== undefined || active !== undefined || busy}
              title={blocked ?? (active ? '已经在探了' : '让引擎现在就探这一条')}
              onClick={onProbe}
            >
              {active ? <LoaderCircle className="animate-spin" aria-hidden /> : <Radar aria-hidden />}
              立即探测
            </Button>
            <button
              type="button"
              onClick={onPick}
              className="text-caption text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              看最近一次
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sub">{children}</dd>
    </div>
  );
}
