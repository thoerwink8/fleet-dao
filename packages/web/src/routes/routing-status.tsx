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

import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import { ChevronDown, Info, LoaderCircle, Radar, SatelliteDish, SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { EmptyState } from '../components/layout/empty-state';
import { KeyValue } from '../components/layout/key-value';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Notice, type NoticeTone } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { StatusBadge, StatusDot } from '../components/layout/status-badge';
import { PoolProblemLine, usePoolProblems } from '../components/pool-problem';
import { ProbeLog } from '../components/probe-log';
import { MOBILE_MQ } from '../components/routing-browse';
import { KindChip } from '../components/routing-kinds';
import { Button } from '../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import {
  buildChannelCards,
  type ChannelCard,
  channelMatchesFilter,
  routeKindMap,
} from '../lib/channel-status';
import { formatAgo, formatClock, TIME } from '../lib/format';
import { useMediaQuery, useNow } from '../lib/hooks';
import { poolIsHeld } from '../lib/pool-holds';
import type { PoolProblem } from '../lib/pool-problems';
import { identityMismatchRoutes } from '../lib/probe-history-view';
import { lastProbeLine, type NextProbeLine, nextProbeLine, PROBE_TIER_WORD } from '../lib/probe-pace-view';
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
  '活跃路由每小时探一次，不活跃的每天一次，派活前 15 分钟内没探过会先探；中转渠道的活跃模型额外问一道身份题。点「立即探测」让法国引擎现在就探。';

/** 渠道目录每 30 秒自己重拉。超过 5 分钟还没再读成，刷新条才标「数据已过期」。 */
const ROUTING_STATUS_STALE_AFTER_MS = 5 * TIME.MIN;

/** 两栏（列表 + 详情）从 lg（1024）起；再窄只画列表，详情改抽屉（#1806）。 */
const DRAWER_MQ = '(max-width: 1023px)';

const STATE_WORD: Readonly<Record<string, { label: string; tone: Tone }>> = {
  ok: { label: '通过', tone: 'done' },
  failed: { label: '不通', tone: 'fail' },
  skipped: { label: '没探', tone: 'stall' },
  not_wired: { label: '插头没接', tone: 'stall' },
};
/** 库里留着的老状态词（已不再写）：当没探。 */
const OLD_STATE_WORD = { label: '没探', tone: 'stall' } as const satisfies { label: string; tone: Tone };

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
  const { problems: poolProblems, error: problemsError } = usePoolProblems();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const [manualPick, setManualPick] = useState<string | null>(null);
  const [cellPick, setCellPick] = useState<{ channelId: string; cellId: number } | null>(null);
  const [routePick, setRoutePick] = useState<{ channelId: string; routeId: string } | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');
  // 不到 lg 只画列表，点一行开详情抽屉（宽屏两栏并排，不看它）；手机抽屉从底部上来，平板从右侧出来
  const drawer = useMediaQuery(DRAWER_MQ);
  const phone = useMediaQuery(MOBILE_MQ);
  const [detailOpen, setDetailOpen] = useState(() => params.has('p'));

  const poolHeld = useMemo(
    () => (poolId: string) => (holds.data ? poolIsHeld(holds.data, poolId) : false),
    [holds.data],
  );
  // 最近一次身份题说出旧答案的路由：疑似换模型（探测记录里读，路由目录里没有这一条）
  const mismatch = useMemo(
    () =>
      historyQuery.data && historyQuery.data.state !== 'unreadable'
        ? identityMismatchRoutes(historyQuery.data.latestByRoute)
        : new Set<string>(),
    [historyQuery.data],
  );
  const cards = useMemo(
    () =>
      routing.data && layers.data
        ? buildChannelCards(routing.data, layers.data, now, poolHeld, mismatch)
        : [],
    [routing.data, layers.data, now, poolHeld, mismatch],
  );
  const kinds = useMemo(
    () =>
      routing.data && layers.data
        ? routeKindMap(routing.data, layers.data, now, poolHeld, mismatch)
        : new Map(),
    [routing.data, layers.data, now, poolHeld, mismatch],
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
        <Section>
          <EmptyState
            icon={SatelliteDish}
            title="目录里一个渠道都没有"
            hint="渠道在库里没配上：去看后端日志"
          />
        </Section>
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
  // 每个渠道下有毛病的池（额度读不到、凭据过期）：渠道的路由是在这些池上跑的
  const channelProblems = new Map<string, PoolProblem[]>();
  for (const r of allRoutes) {
    const p = poolProblems.get(r.poolId);
    if (!p) continue;
    const list = channelProblems.get(r.channelId) ?? [];
    if (!list.includes(p)) channelProblems.set(r.channelId, [...list, p]);
  }
  const probing = new Set(allRoutes.filter((r) => activeFor(requests, r.id)).map((r) => r.channelId));
  // 三样分开数：在线、故障（该修）、待查（还没探到、按量不探、检测中断）；已关、未被用途使用另数，不算坏
  const open = cards.filter((c) => c.state !== 'off' && c.state !== 'idle');
  const okCount = open.filter((c) => (c.state === 'ok' || c.state === 'partial') && !c.interrupted).length;
  const downCount = open.filter((c) => c.state === 'down' && !c.interrupted).length;
  const unknownCount = open.length - okCount - downCount;
  const quietCount = cards.length - open.length;
  const allActive = requests.some((r) => isActive(r) && r.routeIds === undefined);
  const fire = (routeIds?: string[]) => probeNow.mutate(routeIds ? { routeIds } : {});

  const detail = current ? (
    <ChannelDetail
      key={current.channel.id}
      card={current}
      routes={allRoutes.filter((r) => r.channelId === current.channel.id)}
      models={routing.data.models}
      kinds={kinds}
      problems={poolProblems}
      problemsError={problemsError}
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
  ) : null;

  return (
    <Page
      title="渠道状态"
      description={DESCRIPTION}
      refresh={{
        onRefresh: () => void routing.refetch(),
        isFetching: routing.isFetching,
        // 共用秒表一拍最多慢 1 秒。刚读成的时间戳比「现在」新时压回这一拍，避免显示成「1 秒后」。
        dataUpdatedAt: routing.dataUpdatedAt > now ? now : routing.dataUpdatedAt,
        staleAfterMs: ROUTING_STATUS_STALE_AFTER_MS,
      }}
      actions={
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
      }
    >
      <div data-channel-counts className="mb-4 flex flex-wrap items-center gap-1.5">
        <StatusBadge tone="done" label={`${okCount} 个在线`} />
        {downCount > 0 ? <StatusBadge tone="fail" label={`${downCount} 个故障`} /> : null}
        {unknownCount > 0 ? <StatusBadge tone="stall" label={`${unknownCount} 个待查`} /> : null}
        {quietCount > 0 ? <StatusBadge tone="stop" label={`${quietCount} 个已关或未使用`} /> : null}
      </div>
      <ProbeBanner
        requests={requests}
        now={now}
        blocked={blocked}
        error={probeNow.error}
        onDismissError={() => probeNow.reset()}
      />
      <div className="grid items-start gap-4 lg:grid-cols-routing">
        <div className="min-w-0">
          <ChannelFilterBar
            search={search}
            onSearch={setSearch}
            filter={filter}
            onFilter={setFilter}
            counts={filterCounts}
          />
          {visible.length === 0 ? (
            <Section>
              <div role="status">
                <EmptyState
                  icon={SearchX}
                  title={`没有符合的渠道${q ? `：「${search.trim()}」` : ''}${
                    filter !== 'all' ? `，筛选在「${STATE_FILTERS.find((f) => f.id === filter)?.label}」` : ''
                  }`}
                />
              </div>
            </Section>
          ) : (
            // 两栏时列表最高换成 max-h-routing-pane。
            <Section flush>
              <div className="lg:max-h-routing-pane lg:overflow-y-auto">
                <ChannelList
                  cards={visible}
                  selected={drawer && !detailOpen ? undefined : (picked ?? undefined)}
                  probing={probing}
                  problems={channelProblems}
                  now={now}
                  onPick={pickChannel}
                />
              </div>
            </Section>
          )}
          {/* 四段脚注同一个灰、满屏小字：收进 ⓘ，点开才看（#1903） */}
          <div className="mt-2 flex items-center gap-1 text-meta text-muted-foreground">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="怎么看这些状态"
                  title="怎么看这些状态"
                  data-status-notes
                  className="inline-grid size-8 shrink-0 place-items-center rounded-full hover:text-foreground max-md:size-10"
                >
                  <Info className="size-4" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto max-w-sm text-body text-muted-foreground">
                <ul className="space-y-1.5">
                  <li>绿灯只表示本节点最近一轮抽测通过，不保证每次使用都正常。</li>
                  <li>晚于「下次探测时刻」20 分钟还没探，就显示「检测中断」并标红，不拿旧绿灯掩盖中断。</li>
                  <li>已关（人关的）、未被用途使用、池暂停、已下架都不是坏了，只有「故障」才要修。</li>
                  <li>
                    每个用途排哪些模型、能不能派，看{' '}
                    <Link to="/routing" className="underline underline-offset-2">
                      路由
                    </Link>
                    。
                  </li>
                </ul>
              </PopoverContent>
            </Popover>
            怎么看这些状态
          </div>
        </div>
        {drawer ? (
          // 不到 lg（手机、平板）只画列表：点一行从右侧（手机从底部）滑出详情抽屉，不再上下堆两栏（#1806）
          <Sheet open={detailOpen && current !== undefined} onOpenChange={setDetailOpen}>
            <SheetContent
              side={phone ? 'bottom' : 'right'}
              data-channel-drawer
              className={cn('gap-0', phone ? 'max-h-9/10' : 'w-full sm:max-w-xl')}
            >
              <SheetHeader className="border-b py-3 pr-12">
                <SheetTitle className="text-body">渠道详情</SheetTitle>
                <SheetDescription className="sr-only">
                  这个渠道每条路由的状态、探测记录和立即探测
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">{detail}</div>
            </SheetContent>
          </Sheet>
        ) : (
          <div className="min-w-0">
            {detail ?? (
              <Section>
                <div role="status">
                  <EmptyState icon={SearchX} title="没有可看的渠道，换个搜索词或筛选" />
                </div>
              </Section>
            )}
          </div>
        )}
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
  const lines: { key: string; tone: NoticeTone; text: string; onClose?: () => void }[] = [];
  if (error) {
    lines.push({ key: 'error', tone: 'fail', text: `没探成：${errorText(error)}`, onClose: onDismissError });
  }
  if (blocked && !error) lines.push({ key: 'blocked', tone: 'stall', text: blocked });
  for (const r of active) {
    const what = r.routeIds ? `${r.routeIds.length} 条路由` : '全部路由';
    lines.push({
      key: r.requestId,
      tone: r.why ? 'stall' : 'info',
      text: `正在探${what}：${activityText(r, now)}`,
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
        <li key={l.key}>
          <Notice
            tone={l.tone}
            action={
              l.onClose ? (
                <button
                  type="button"
                  onClick={l.onClose}
                  className="inline-flex min-h-8 items-center px-1 text-meta underline underline-offset-2 max-md:min-h-10"
                >
                  知道了
                </button>
              ) : undefined
            }
          >
            <span className="break-words">{l.text}</span>
          </Notice>
        </li>
      ))}
    </ul>
  );
}

/** 已关、未使用、已下架、池暂停：不是坏了，默认折起来（渠道里可能有几百条）。 */
const QUIET_KINDS: ReadonlySet<RouteStateKind> = new Set(['off', 'unused', 'retired', 'held']);
const ROUTE_QUIET_FIRST = 20;
const ROUTE_QUIET_STEP = 50;

/** 路由行的先后：该修的在前，要看一眼的其次，在线的，最后是已关、没用的。同一档里探过的在前、再按编号。 */
const KIND_ORDER: readonly RouteStateKind[] = [
  'fault',
  'interrupted',
  'degraded',
  'blocked',
  'unknown',
  'unprobed',
  'live',
  'held',
  'off',
  'retired',
  'unused',
];

/** 渠道头部那一句中文结论（只说通不通、几条路，不带探针的原文）。运行中失败的有自己的说明块，这里不写。 */
function conclusionOf(card: ChannelCard): string | undefined {
  if (card.failover || !card.reason) return undefined;
  if (card.state === 'partial') return `有 ${card.deadRoutes} 条在用的路不通，其余在线`;
  if (card.state === 'down') return `在用的 ${card.activeRoutes} 条路都不通`;
  return '探针还没探通，原因见下面';
}

function ChannelDetail({
  card,
  routes,
  models,
  kinds,
  problems,
  problemsError,
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
  /** 每个池的毛病（额度读不到、凭据过期）；提醒没读成时是空的，看 problemsError。 */
  problems: ReadonlyMap<string, PoolProblem>;
  problemsError: unknown;
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
  // 折起来的已关、未使用路由：点开才铺，先铺 20 条，每次「再看」加 50 条
  const [quietShown, setQuietShown] = useState(false);
  const [quietExtra, setQuietExtra] = useState(0);
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
  // 默认只铺要人看的；已关、未使用（人关的、没用途在用的、下架、池暂停）折成一行，点开再分批铺（#1798 线上点验：一个渠道 256 条）
  const attention = sorted.filter((r) => !QUIET_KINDS.has(kindOf(r)));
  const quiet = sorted.filter((r) => QUIET_KINDS.has(kindOf(r)));
  const quietIndex = (id: string | undefined) =>
    id === undefined ? -1 : quiet.findIndex((r) => r.id === id);
  // 点路由行看最近一次、手风琴展开的那条恰好折在里面：自动展开并铺到它为止
  const wantedIndex = Math.max(quietIndex(focus?.cell?.routeId), quietIndex(openRoute ?? undefined));
  const quietOpen = quietShown || wantedIndex >= 0;
  const quietCount = Math.max(ROUTE_QUIET_FIRST + quietExtra, wantedIndex + 1);
  const quietOff = quiet.filter((r) => kindOf(r) !== 'unused').length;
  const quietParts = [
    quietOff > 0 ? `已关 ${quietOff} 条` : undefined,
    quiet.length - quietOff > 0 ? `未使用 ${quiet.length - quietOff} 条` : undefined,
  ].filter((x): x is string => x !== undefined);
  const renderRow = (r: Route) => (
    <RouteRow
      key={r.id}
      route={r}
      kind={kindOf(r)}
      lastCell={history.state === 'ok' ? history.latestByRoute.find((c) => c.routeId === r.id) : undefined}
      model={models.find((m) => m.id === r.modelId)}
      problem={problems.get(r.poolId)}
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
  );
  const channelPools = [...new Set(routes.map((r) => r.poolId))].flatMap((id) => {
    const p = problems.get(id);
    return p ? [p] : [];
  });
  return (
    <Section
      title={
        <span className="flex flex-wrap items-center gap-x-2">
          {card.channel.name}
          <span className="text-meta font-normal text-muted-foreground">
            {card.channel.billing === 'metered' ? '按量计费' : '订阅'} · {routes.length} 条路由
          </span>
        </span>
      }
      description={conclusionOf(card)}
      actions={
        <div className="flex items-center gap-2">
          <StatusBadge tone={card.tone} label={card.label} />
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
        <Notice tone="fail" className="mb-3">
          检测中断：晚于下次探测时刻 20 分钟还没探这个渠道，上次的结论不再当现状
          {card.probedAt ? `（${formatAgo(card.probedAt, now)}）` : null}
        </Notice>
      ) : null}
      {card.reason && !card.failover ? (
        // 探针写的原文常常是英文、很长：头部只留上面那句中文结论，原文收在这条可展开的提醒里（#1903）
        <div data-raw-reason className="mb-3">
          <Notice tone={card.tone === 'fail' ? 'fail' : 'stall'}>
            <details>
              <summary className="cursor-pointer font-medium max-md:min-h-10">探针报的原文，点开看</summary>
              <p className="mt-1 break-words">{card.reason}</p>
            </details>
          </Notice>
        </div>
      ) : null}
      {card.fallback ? <p className="mb-3 text-body text-ink-fail">{card.fallback}</p> : null}
      {card.failover ? <FailoverNote failover={card.failover} now={now} /> : null}
      {channelPools.length > 0 ? (
        <div data-pool-problems className="mb-3">
          <Notice tone="stall">
            <div className="space-y-1">
              {channelPools.map((p) => (
                <PoolProblemLine key={p.poolId} problem={{ ...p }} now={now} />
              ))}
            </div>
          </Notice>
        </div>
      ) : problemsError ? (
        <p data-pool-problems="unreadable" className="mb-3 text-meta text-ink-stall">
          账号池的毛病（额度读不到、凭据过期）没读成：{errorText(problemsError)}。这里没写不代表没有。
        </p>
      ) : null}
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
        <p className="text-body text-muted-foreground">这个渠道下一条路由都没有。</p>
      ) : (
        <>
          {attention.length > 0 ? (
            <ol aria-label={`${card.channel.name} 的路由`} className="space-y-1.5">
              {attention.map(renderRow)}
            </ol>
          ) : null}
          {quiet.length > 0 ? (
            <div data-route-fold="quiet" className={attention.length > 0 ? 'mt-2' : undefined}>
              <button
                type="button"
                aria-expanded={quietOpen}
                aria-controls="route-fold-quiet"
                onClick={() => setQuietShown(!quietOpen)}
                className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 max-md:min-h-10 text-meta text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronDown
                  className={cn('size-3.5 transition-transform', quietOpen && 'rotate-180')}
                  aria-hidden
                />
                {quietParts.join(' · ')}，{quietOpen ? '收起' : '点开看'}
              </button>
              {quietOpen ? (
                <div id="route-fold-quiet">
                  <ol aria-label={`${card.channel.name} 已关和未使用的路由`} className="mt-1.5 space-y-1.5">
                    {quiet.slice(0, quietCount).map(renderRow)}
                  </ol>
                  {quiet.length > quietCount ? (
                    <button
                      type="button"
                      data-route-fold="more"
                      onClick={() => setQuietExtra(quietCount - ROUTE_QUIET_FIRST + ROUTE_QUIET_STEP)}
                      className="mt-1.5 inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-meta text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      再看 {Math.min(ROUTE_QUIET_STEP, quiet.length - quietCount)} 条（还有{' '}
                      {quiet.length - quietCount} 条没显示）
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}

function RouteRow({
  route: r,
  kind,
  lastCell,
  model,
  problem,
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
  /** 这条路由在探测记录里的最近一次：上次是谁触发的（路由目录里没有这一列）。 */
  lastCell: ProbeHistoryCell | undefined;
  model: Model | undefined;
  /** 这条路由的账号池有没有要人动手的毛病（额度读不到、凭据过期）。 */
  problem: PoolProblem | undefined;
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
  const word = probe
    ? (STATE_WORD[probe.state] ?? OLD_STATE_WORD)
    : { label: '还没探到', tone: 'stop' as Tone };
  // 上次那一句：触发者、种类优先读路由目录的 probeTrigger、probeKind；目录没给（老后端）才用探测记录里同一次的（相差不到 1 分钟）
  const sameProbe =
    probe !== undefined &&
    lastCell !== undefined &&
    Math.abs(Date.parse(lastCell.probedAt) - Date.parse(probe.at)) < TIME.MIN;
  const lastLine = probe
    ? lastProbeLine(
        probe.at,
        {
          kind: r.probeKind ?? (sameProbe ? lastCell?.kind : undefined),
          trigger: r.probeTrigger ?? (sameProbe ? lastCell?.trigger : undefined),
        },
        now,
      )
    : null;
  const next: NextProbeLine | null = nextProbeLine(r, now);
  const seconds = probeSeconds(r, requests);
  const name = model?.displayName ?? r.modelId;
  const bodyId = `route-body-${r.id}`;
  const failed = kind === 'fault';
  const alarm = kind === 'fault' || kind === 'interrupted';
  return (
    <li
      data-route={r.id}
      data-probe={active ? active.state : (probe?.state ?? 'none')}
      data-kind={kind}
      className={cn(
        'rounded-lg border',
        alarm && !active && 'border-st-fail-line',
        (kind === 'off' || kind === 'unused' || kind === 'retired') && 'bg-muted',
        picked && 'ring-2 ring-ring',
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
        <span className="shrink-0 text-body font-semibold">{name}</span>
        <span className="num min-w-0 flex-1 truncate text-meta text-muted-foreground" title={r.id}>
          {r.id}
        </span>
        {active ? (
          <StatusBadge tone="run" label={active.state === 'running' ? '探测中' : '排队中'} />
        ) : (
          <KindChip kind={kind} />
        )}
        {kind === 'unused' && !active && (probe?.state === 'ok' || probe?.state === 'failed') ? (
          // 没用途在用的路由点立即探测（#1630）：灰的「未被用途使用」不变，结论在旁边写出来，不画红
          <StatusBadge
            tone={probe.state === 'ok' ? 'done' : 'stall'}
            label={probe.state === 'ok' ? '探过：通' : '探过：不通'}
          />
        ) : null}
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {lastLine || next ? (
        <div data-probe-pace className="num flex flex-wrap gap-x-3 gap-y-0.5 px-3 pb-1.5 text-meta">
          {lastLine ? (
            <p data-probe-last className="text-muted-foreground">
              {lastLine}
            </p>
          ) : null}
          {next ? (
            <p
              data-probe-next={next.tone}
              className={cn(
                next.tone === 'fail' && 'font-medium text-ink-fail',
                next.tone === 'warn' && 'text-ink-stall',
                next.tone === 'normal' && 'text-muted-foreground',
              )}
            >
              {next.text}
            </p>
          ) : null}
        </div>
      ) : null}
      {problem ? <PoolProblemLine problem={problem} className="px-3 pb-1.5" /> : null}
      {kind === 'degraded' && probe?.detail && !open ? (
        <p className="truncate px-3 pb-2 text-meta text-ink-doubt" title={probe.detail}>
          {probe.detail}
        </p>
      ) : null}
      {failed && probe?.detail && !open ? (
        <p className="truncate px-3 pb-2 text-meta text-ink-fail" title={probe.detail}>
          {probe.detail}
        </p>
      ) : null}
      {open ? (
        <div id={bodyId} className="border-t px-3 pb-3 pt-2.5">
          <p className="mb-2 text-meta text-muted-foreground">{routeStateWhy[kind]}</p>
          {active ? (
            <p className={cn('mb-2 text-meta', active.why ? 'text-ink-stall' : 'text-ink-run')}>
              {activityText(active, now)}
            </p>
          ) : null}
          {failure ? (
            <p role="alert" className="mb-2 text-meta text-ink-fail">
              {formatClock(failure.requestedAt)} {sourceText(failure) ?? '点的立即探测'}没成：
              {failure.why ?? '没写原因'}
            </p>
          ) : null}
          <KeyValue
            layout="grid"
            cols={4}
            items={[
              { label: '探针结论', value: word.label },
              {
                label: '最近一次',
                value: probe ? (
                  <span className="num">
                    {formatClock(probe.at)}（{formatAgo(probe.at, now)}）
                  </span>
                ) : (
                  '探针还没看过'
                ),
              },
              {
                label: '耗时',
                value:
                  seconds !== undefined ? (
                    <span className="num">{seconds.toFixed(seconds < 10 ? 1 : 0)} 秒</span>
                  ) : (
                    <span className="text-muted-foreground">
                      {probe && probe.state !== 'ok' && probe.state !== 'failed' ? '没真探' : '没量到'}
                    </span>
                  ),
              },
              { label: '执行方式', value: r.hostId },
              {
                label: '节奏档',
                value: r.probeTier ? (
                  `${PROBE_TIER_WORD[r.probeTier].label}${PROBE_TIER_WORD[r.probeTier].every ? `，${PROBE_TIER_WORD[r.probeTier].every}` : ''}`
                ) : (
                  <span className="text-muted-foreground">库里还没写</span>
                ),
              },
            ]}
          />
          <div className="mt-2.5">
            <div className="mb-1 text-meta text-muted-foreground">
              {probe?.state === 'failed' ? '失败原因（原文）' : '原文'}
            </div>
            <pre
              className={cn(
                'max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted px-2.5 py-2 font-mono text-meta',
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
              className="text-meta text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              看最近一次
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
