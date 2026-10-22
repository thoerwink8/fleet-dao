// 渠道状态页（#1087；近 60 次真历史 #1139；重做 #1366；照 Arco 迁 #3533，样稿 canvas/RoutingStatus.dc.html）：
// 左边一卡「渠道」（搜索、状态筛选、一列摘要行），右边（窄屏是抽屉）点开的渠道详情：头部、路由、探测记录三块。
// 默认全部折叠：一行只写名字、状态、顺位、几条在线/故障/已关、最近一次探测。故障的渠道置顶；低频的「全部立即探测」收进卡头「更多」。
// 详情里才有每条路由（手风琴，一次只开一条）、原文、立即探测；再下面是「探测记录」（components/probe-log.tsx，#1638）：
// 每一次探测一行，新的在上，点一行（或点上面的格子）展开请求、响应原文。
// 页面只拼 components/layout 的件，不写样式类（design 第三节、lint-design R13–R20）；出问题的行只留状态标签，不画红边线、红框。
// 改这里之前必须知道：
// - 通不通、排第几、运行中失败、检测中断都在 lib/channel-status.ts 判，和路由页顶上那一行同一份；这里只画。
// - 状态种类（在线、故障、已关、未被用途使用、池暂停、已下架、未探）在 lib/route-state.ts：只有「该在线却探不通」才是故障、画红。
//   人关的、没用途在用的、整池暂停的不是坏了，也不进「故障」的数。状态词全走字典（theme/status-dict.ts 的 route 域）。
// - 「立即探测」点下去由法国引擎接手（engine/src/jobs/route-probe-now.ts），走到哪由后端从操作记录现算；页面在探的时候
//   每 3 秒重拉一次，探完自己把路由目录也重拉（api/client.tsx 的 useRouteProbeStatus）。已经在探的路由不能再点。
// - 探不了要说清是哪样：引擎关着、没连上、没查成、没人接手、引擎说没探成，各有一句，不显示成「通」或空白。
// - 近 60 次来自探针历史（route_probe_history），本渠道所有路由按时间排，一次一格。没探和不通颜色分开。
//   均耗时、可用率按这 60 格算。库读不到写「没查成」，不拿空格子冒充没有。引擎关着这一份照样读。
// - 路由折叠区（已关、未使用）先铺 20 条，每次「再看」加 50 条；账号池的毛病（额度读数过期、要人处理）挂在渠道和路由上。

import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
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
  channelStatusKey,
  FailoverNote,
  HistoryStrip,
  kindStatus,
} from '../components/channel-status';
import { Breadcrumb } from '../components/layout/breadcrumb';
import { Button } from '../components/layout/button';
import { Code } from '../components/layout/code';
import { Descriptions, type DescriptionsItem } from '../components/layout/descriptions';
import { Drawer } from '../components/layout/drawer';
import { EmptyState } from '../components/layout/empty-state';
import { Grid } from '../components/layout/grid';
import { List, ListRow } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Notice, type NoticeTone } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { RowMenu, RowMenuItem } from '../components/layout/row-menu';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { StatusBadge } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { PoolProblemLine, usePoolProblems } from '../components/pool-problem';
import { ProbeLog } from '../components/probe-log';
import {
  buildChannelCards,
  type ChannelCard,
  channelMatchesFilter,
  quotaCountText,
  quotaResetLine,
  routeKindMap,
} from '../lib/channel-status';
import { formatAgo, formatClock, TIME } from '../lib/format';
import { useMediaQuery, useNow } from '../lib/hooks';
import { poolIsHeld } from '../lib/pool-holds';
import type { PoolProblem } from '../lib/pool-problems';
import {
  currentQuotaCells,
  identityMismatchRoutes,
  isCurrentProbe,
  PROBE_KIND_WORD,
  quotaResetText,
} from '../lib/probe-history-view';
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
  countsText,
  quotaProbeWhy,
  type RouteStateKind,
  routeStateLabel,
  routeStateWhy,
  STATE_FILTERS,
  type StateFilter,
} from '../lib/route-state';
import { usePhone } from '../lib/viewport';
import type { StatusKey } from '../theme/status-dict';

export function meta() {
  return [{ title: brand.title('渠道状态') }];
}

const SUMMARY = '每条路由现在通不通，多久探一次。';
/** 面包屑：路由 / 渠道状态（渠道状态归在路由下）。 */
const CRUMB = <Breadcrumb items={[{ label: '路由', href: '/routing' }, { label: '渠道状态' }]} />;
const DESCRIPTION =
  '活跃路由每小时探一次，不活跃的每天一次，派活前 15 分钟内没探过会先探；中转渠道的活跃模型额外问一道身份题。点「立即探测」让法国引擎现在就探。';

/** 渠道目录每 30 秒自己重拉。超过 5 分钟还没再读成，刷新条才标「数据已过期」。 */
const ROUTING_STATUS_STALE_AFTER_MS = 5 * TIME.MIN;

/** 两栏（列表 + 详情）从 lg（1024）起；再窄只画列表，详情改抽屉（#1806）。 */
const DRAWER_MQ = '(max-width: 1023px)';

/** 立即探测的记录没读到时的占位：读不到由 engineBlock 单独写一句，所有探测按钮跟着置灰，不当成「没有在探的」。 */
const NO_REQUESTS: readonly RouteProbeRequest[] = [];

/** 一条路由探针的结论对应的字典键（库里留着的老状态词当没探）。 */
function probeStateStatus(state: string): StatusKey {
  if (state === 'ok') return 'route:probe:passed';
  if (state === 'failed') return 'route:probe:failed';
  if (state === 'not_wired') return 'route:probe:not_wired';
  return 'route:probe:not_probed';
}

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
  const [helpOpen, setHelpOpen] = useState(false);
  // 不到 lg 只画列表，点一行开详情抽屉（宽屏两栏并排，不看它）；手机抽屉从底部上来，平板从右侧出来
  const drawer = useMediaQuery(DRAWER_MQ);
  const phone = usePhone();
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
  // 连通但额度耗尽的路由（#2939）：只认和路由当前探针同一次的最新记录；历史读不到时没有（页面另写没读成）
  const quotaCells = useMemo(
    () =>
      routing.data && historyQuery.data && historyQuery.data.state !== 'unreadable'
        ? currentQuotaCells(historyQuery.data.latestByRoute, routing.data.routes)
        : new Map<string, ProbeHistoryCell>(),
    [routing.data, historyQuery.data],
  );
  const cards = useMemo(
    () =>
      routing.data && layers.data
        ? buildChannelCards(routing.data, layers.data, now, poolHeld, mismatch, quotaCells)
        : [],
    [routing.data, layers.data, now, poolHeld, mismatch, quotaCells],
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

  const requests = probe.data === undefined ? NO_REQUESTS : probe.data.requests;
  const blocked = engineBlock(probe.data, probe.error);
  const history = toHistory(historyQuery.data, historyQuery.error);

  // 从没读成：整页只写哪一份没读成和原因（各带重试）。读成过、刷新时失败：照旧画上一次的，顶上一条横幅（#1922）
  if ((routing.error && !routing.data) || (layers.error && !layers.data)) {
    return (
      <Page title="渠道状态" breadcrumb={CRUMB} description={SUMMARY} detail={DESCRIPTION}>
        <Stack gap="md">
          {routing.error ? (
            <LoadError what="渠道目录" error={routing.error} onRetry={() => void routing.refetch()} />
          ) : null}
          {layers.error ? (
            <LoadError what="路由两层" error={layers.error} onRetry={() => void layers.refetch()} />
          ) : null}
        </Stack>
      </Page>
    );
  }
  if (!routing.data || !layers.data) {
    return (
      <Page title="渠道状态" breadcrumb={CRUMB} description={SUMMARY} detail={DESCRIPTION}>
        <LoadingRows rows={5} />
      </Page>
    );
  }
  if (cards.length === 0) {
    return (
      <Page title="渠道状态" breadcrumb={CRUMB} description={SUMMARY} detail={DESCRIPTION}>
        <Section>
          <EmptyState title="目录里一个渠道都没有" hint="渠道在库里没配上：去看后端日志" />
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
  const allActive = requests.some((r) => isActive(r) && r.routeIds === undefined);
  const fire = (routeIds?: string[]) => {
    // 同一帧里的第二下挡掉：已经有一次在发就不再发
    if (probeNow.isPending) return;
    probeNow.mutate(routeIds ? { routeIds } : {});
  };

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

  const list = (
    <Section
      flush
      title={
        <>
          渠道 <Tag>{cards.length}</Tag>
        </>
      }
      actions={
        // 低频：整个目录一起探。放卡头「更多」里，不占页头
        <RowMenu label="更多操作：渠道" title="全部立即探测" reveal={false}>
          <RowMenuItem
            disabled={blocked !== undefined || allActive || probeNow.isPending}
            onSelect={() => fire()}
          >
            {blocked
              ? `全部立即探测（${blocked}）`
              : allActive
                ? '全部立即探测（全部路由正在探）'
                : '全部立即探测'}
          </RowMenuItem>
        </RowMenu>
      }
      toolbar={
        <ChannelFilterBar
          search={search}
          onSearch={setSearch}
          filter={filter}
          onFilter={setFilter}
          counts={filterCounts}
        />
      }
      footer={
        <Stack gap="sm">
          <div>
            <Button variant="text" size="xs" aria-expanded={helpOpen} onClick={() => setHelpOpen((v) => !v)}>
              怎么看这些状态
            </Button>
          </div>
          {helpOpen ? (
            <Notice tone="info">
              <Stack gap="sm">
                <Text>绿灯只表示本节点最近一轮抽测通过，不保证每次使用都正常。</Text>
                <Text>晚于「下次探测时刻」20 分钟还没探，就显示「检测中断」并标红，不拿旧绿灯掩盖中断。</Text>
                <Text>已关（人关的）、未被用途使用、池暂停、已下架都不是坏了，只有「故障」才要修。</Text>
                <Text>
                  名字下面的顺位是优先级：数字小的先用。路由表里该修的在前，已关、未使用的折在最后。
                </Text>
                <Text>可用率按近 60 次真探算，没真探的不进可用率。</Text>
                <Text>
                  每个用途排哪些模型、能不能派，看{' '}
                  <Button variant="text" size="xs" href="/routing">
                    路由
                  </Button>
                  。
                </Text>
              </Stack>
            </Notice>
          ) : null}
        </Stack>
      }
    >
      {visible.length === 0 ? (
        <div role="status">
          <EmptyState
            size="inline"
            title={`没有符合的渠道${q ? `：「${search.trim()}」` : ''}${
              filter !== 'all' ? `，筛选在「${STATE_FILTERS.find((f) => f.id === filter)?.label}」` : ''
            }`}
          />
        </div>
      ) : (
        <ChannelList
          cards={visible}
          selected={drawer && !detailOpen ? undefined : (picked ?? undefined)}
          probing={probing}
          problems={channelProblems}
          now={now}
          onPick={pickChannel}
        />
      )}
    </Section>
  );

  return (
    <Page
      title="渠道状态"
      breadcrumb={CRUMB}
      description={SUMMARY}
      detail={DESCRIPTION}
      refresh={{
        onRefresh: () => {
          void routing.refetch();
          void layers.refetch();
        },
        isFetching: routing.isFetching,
        // 共用秒表一拍最多慢 1 秒。刚读成的时间戳比「现在」新时压回这一拍，避免显示成「1 秒后」。
        dataUpdatedAt: routing.dataUpdatedAt > now ? now : routing.dataUpdatedAt,
        staleAfterMs: ROUTING_STATUS_STALE_AFTER_MS,
      }}
    >
      <Stack>
        {routing.error || layers.error ? (
          <LoadError
            text={`${routing.error ? '渠道目录' : '路由两层'}刷新没读成，下面是上一次读到的：${errorText(routing.error ?? layers.error)}`}
            error={routing.error ?? layers.error}
            onRetry={() => {
              void routing.refetch();
              void layers.refetch();
            }}
          />
        ) : null}
        <ProbeBanner
          requests={requests}
          now={now}
          blocked={blocked}
          error={probeNow.error}
          onDismissError={() => probeNow.reset()}
        />
        {drawer ? (
          // 不到 lg（手机、平板）只画列表：点一行从右侧（手机从底部）滑出详情抽屉，不再上下堆两栏（#1806）
          <>
            {list}
            <Drawer
              open={detailOpen && current !== undefined}
              onOpenChange={setDetailOpen}
              title="渠道详情"
              description="这个渠道每条路由的状态、探测记录和立即探测"
              side={phone ? 'bottom' : 'right'}
              width="lg"
              data={{ 'data-channel-drawer': '' }}
            >
              {detail}
            </Drawer>
          </>
        ) : (
          <Grid preset="split">
            {list}
            {detail ?? (
              <Section>
                <div role="status">
                  <EmptyState title="没有可看的渠道，换个搜索词或筛选" />
                </div>
              </Section>
            )}
          </Grid>
        )}
      </Stack>
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
    <List divided={false} aria-label="立即探测">
      <li>
        <Stack gap="sm">
          {lines.map((l) => (
            <Notice
              key={l.key}
              tone={l.tone}
              action={
                l.onClose ? (
                  <Button size="xs" variant="secondary" onClick={l.onClose}>
                    知道了
                  </Button>
                ) : undefined
              }
            >
              <span className="break-words">{l.text}</span>
            </Notice>
          ))}
        </Stack>
      </li>
    </List>
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

/** 结论块第二行的短话：没有探针报错时也要有一句（在线、关着、没人用、运行中失败顺延到谁）。整句放悬停。 */
function heroLineOf(card: ChannelCard): string {
  if (card.failover) {
    const to = card.failover.fallback;
    // 状态标签已经写了「运行中失败，已顺延」：这句只说活改派给了谁，不再重复
    return to
      ? `活改派到 ${to.channelName} · ${to.modelName}`
      : '还没顺延出去：没有别的渠道可派，或还没有新的活';
  }
  if (card.interrupted) return '上次探测已过时，结论不再当现状';
  const quota = card.quota;
  const said = conclusionOf(card);
  // 连通但额度耗尽（#2939）：连接是通的；全部在用的路耗尽才说「都耗尽」，部分路耗尽说清几条
  if (said) return quota ? `${said}；另有 ${quota.routes} 条连通但额度耗尽` : said;
  if (quota && card.state === 'ok') {
    return quota.routes === card.activeRoutes
      ? `连通，但在用的 ${card.activeRoutes} 条路额度都耗尽了`
      : `连通；在用的 ${card.activeRoutes} 条路里 ${quota.routes} 条额度耗尽，其余可用`;
  }
  if (card.kind === 'off' || card.kind === 'retired' || card.kind === 'held') return '整个渠道关着，不派活';
  if (card.kind === 'unused') return '没有用途在用它，不主动探';
  if (card.state === 'ok') return `在用的 ${card.activeRoutes} 条路都在线`;
  if (card.channel.billing === 'metered') return '按量计费，平时不花钱去探';
  return '探针还没给出结论';
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
  const billing = card.channel.billing === 'metered' ? '按量计费' : '订阅';
  const heroLine = heroLineOf(card);
  // 灰字一行：计费、几条路由、各状态几条、最近一次探测；放不下截断，整句在悬停里
  const heroNotes = [
    `${billing} · ${routes.length} 条路由`,
    countsText(card.counts),
    quotaCountText(card) ?? null,
    card.quota ? quotaResetLine(card.quota) : null,
    history.state === 'unreadable' ? '额度状态没读成（探针历史读不到）' : null,
    card.probedAt ? `${formatAgo(card.probedAt, now)}探的` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');
  const probeBlockedReason =
    blocked ?? (idle.length === 0 ? '这个渠道的路由都在探' : busy ? '正在发出探测请求' : undefined);
  return (
    <section aria-label={`${card.channel.name} 详情`} data-channel-detail>
      <Stack>
        {/* 头部：名字、一句结论加状态、灰字细节；「探这个渠道」在头部右边 */}
        <Section
          data-channel-hero
          title={card.channel.name}
          description={
            <span data-hero-line title={heroLine}>
              <span data-hero-text>{heroLine}</span> <StatusBadge status={channelStatusKey(card)} />
            </span>
          }
          actions={
            <Button
              size="sm"
              variant="outline"
              disabledReason={probeBlockedReason}
              title="让引擎现在就探这个渠道的每条路由"
              onClick={() => onProbe(idle)}
            >
              探这个渠道
            </Button>
          }
        >
          <Stack gap="md">
            <div data-hero-notes title={heroNotes}>
              <Text size="meta" tone="muted" truncate>
                {heroNotes}
              </Text>
            </div>
            {card.interrupted ? (
              <Notice tone="fail" role="status">
                检测中断：晚于下次探测时刻 20 分钟还没探这个渠道，上次的结论不再当现状
                {card.probedAt ? `（${formatAgo(card.probedAt, now)}）` : null}
              </Notice>
            ) : null}
            {card.reason && !card.failover ? (
              // 探针写的原文常常是英文、很长：头部只留上面那句中文结论，原文收在这条可展开的提醒里（#1903）
              <div data-raw-reason>
                <Notice tone={card.tone === 'fail' ? 'fail' : 'stall'} role="status">
                  <details>
                    <summary>探针报的原文，点开看</summary>
                    <p className="break-words">{card.reason}</p>
                  </details>
                </Notice>
              </div>
            ) : null}
            {card.fallback ? (
              <Text size="meta" tone="danger">
                {card.fallback}
              </Text>
            ) : null}
            {card.failover ? <FailoverNote failover={card.failover} now={now} /> : null}
            {channelPools.length > 0 ? (
              <div data-pool-problems>
                <Notice tone="stall" role="status">
                  <Stack gap="sm">
                    {channelPools.map((p) => (
                      <PoolProblemLine key={p.poolId} problem={{ ...p }} now={now} />
                    ))}
                  </Stack>
                </Notice>
              </div>
            ) : problemsError ? (
              <div data-pool-problems="unreadable">
                <Text size="meta" tone="warning">
                  账号池的毛病（额度读不到、凭据过期）没读成：{errorText(problemsError)}。这里没写不代表没有。
                </Text>
              </div>
            ) : null}
          </Stack>
        </Section>
        {/* 路由在前（要人看的那几条），探测记录在后：原来探测记录夹在中间，要滚过 10 行记录才看到路由 */}
        <Section
          flush
          title={
            <>
              路由 <Tag>{sorted.length}</Tag>
            </>
          }
        >
          {sorted.length === 0 ? (
            <EmptyState size="inline" title="这个渠道下一条路由都没有。" />
          ) : (
            <List aria-label={`${card.channel.name} 的路由`}>
              {attention.map(renderRow)}
              {quiet.length > 0 ? (
                <ListRow
                  data-route-fold="quiet"
                  expandable
                  open={quietOpen}
                  onOpenChange={() => setQuietShown(!quietOpen)}
                  title={
                    <Text size="meta" tone="secondary">
                      {quietParts.join(' · ')}，{quietOpen ? '收起' : '点开看'}
                    </Text>
                  }
                  details={
                    <Stack gap="sm">
                      <List aria-label={`${card.channel.name} 已关和未使用的路由`}>
                        {quiet.slice(0, quietCount).map(renderRow)}
                      </List>
                      {quiet.length > quietCount ? (
                        <div>
                          <Button
                            variant="text"
                            size="xs"
                            data-route-fold="more"
                            onClick={() => setQuietExtra(quietCount - ROUTE_QUIET_FIRST + ROUTE_QUIET_STEP)}
                          >
                            再看 {Math.min(ROUTE_QUIET_STEP, quiet.length - quietCount)} 条（还有{' '}
                            {quiet.length - quietCount} 条没显示）
                          </Button>
                        </div>
                      ) : null}
                    </Stack>
                  }
                />
              ) : null}
            </List>
          )}
        </Section>
        <Section title="探测记录">
          <Stack>
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
          </Stack>
        </Section>
      </Stack>
    </section>
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
  // 上次那一句：触发者、种类优先读路由目录的 probeTrigger、probeKind；目录没给（老后端）才用探测记录里同一次的（相差不到 1 分钟）
  const sameProbe = isCurrentProbe(lastCell, probe);
  // 连通但额度耗尽（#2939）：只认和当前探针同一次的那条记录，探针已经更新过的旧额度记录不作数
  const quotaCell =
    sameProbe &&
    probe?.state === 'ok' &&
    lastCell &&
    lastCell.quotaExhausted === true &&
    lastCell.result === 'passed'
      ? lastCell
      : undefined;
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
  // 同一次探针写明额度耗尽时，不再用「在线」那句里的「额度够」。分类仍是在线，这句话只改说法。
  const why = quotaCell && kind === 'live' ? quotaProbeWhy(quotaCell) : routeStateWhy[kind];
  const spoken = active
    ? active.state === 'running'
      ? '探测中'
      : '排队中'
    : quotaCell && kind === 'live'
      ? why
      : quotaCell
        ? `${routeStateLabel[kind]}，${PROBE_KIND_WORD.quota.label}（${quotaResetText(quotaCell.resetsAt)}）`
        : routeStateLabel[kind];
  const failed = kind === 'fault';
  const quietKind = kind === 'off' || kind === 'unused' || kind === 'retired';
  const probedUnused = kind === 'unused' && !active && (probe?.state === 'ok' || probe?.state === 'failed');
  const metaTitle = [
    r.id,
    lastLine,
    next?.text,
    probedUnused ? (probe?.state === 'ok' ? '探过：通' : '探过：不通') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const probeReason = blocked ?? (active ? '已经在探了' : busy ? '正在发出探测请求' : undefined);
  const facts: DescriptionsItem[] = [
    {
      label: '探针结论',
      value: quotaCell ? (
        <StatusBadge status="route:probe:quota" />
      ) : probe ? (
        <StatusBadge status={probeStateStatus(probe.state)} />
      ) : (
        '还没探到'
      ),
    },
    ...(quotaCell
      ? [
          {
            label: '真实原因',
            value: <span data-field="quota-detail">{quotaCell.detail ?? '（上游没写具体原因）'}</span>,
          },
          {
            label: '额度重置',
            value: <span data-field="quota-resets">{quotaResetText(quotaCell.resetsAt)}</span>,
          },
        ]
      : []),
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
          <Text tone="muted">
            {probe && probe.state !== 'ok' && probe.state !== 'failed' ? '没真探' : '没量到'}
          </Text>
        ),
    },
    { label: '执行方式', value: r.hostId },
    {
      label: '节奏档',
      value: r.probeTier ? (
        `${PROBE_TIER_WORD[r.probeTier].label}${PROBE_TIER_WORD[r.probeTier].every ? `，${PROBE_TIER_WORD[r.probeTier].every}` : ''}`
      ) : (
        <Text tone="muted">库里还没写</Text>
      ),
    },
  ];
  return (
    <ListRow
      data-route={r.id}
      data-probe={active ? active.state : (probe?.state ?? 'none')}
      data-kind={kind}
      tall
      expandable
      open={open}
      onOpenChange={onToggle}
      selected={picked}
      rowLabel={`${name} ${r.id}：${spoken}`}
      title={
        // 名字后面紧跟一个状态；名字是认路的那一样，不截断。出问题的行只留状态标签，不画红边线、红框
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <Text strong tone={quietKind ? 'muted' : 'default'}>
            {name}
          </Text>
          {active ? (
            <StatusBadge status={active.state === 'running' ? 'route:probe:running' : 'task:queued'} />
          ) : quotaCell && kind === 'live' ? null : (
            <StatusBadge status={kindStatus(kind)} title={routeStateWhy[kind]} />
          )}
          {quotaCell && kind === 'live' && !active ? (
            <span data-route-quota title={quotaProbeWhy(quotaCell)}>
              <StatusBadge status="route:probe:quota" />
            </span>
          ) : null}
        </Stack>
      }
      meta={
        <Stack gap="sm">
          {/* 小字一行不折：路由号、上次、下次（正常的）、没用途在用的探过结论；放不下截断，整句在悬停里 */}
          <div data-route-meta title={metaTitle}>
            <Text size="meta" tone="muted" truncate>
              <span className="num">
                {r.id}
                {lastLine ? (
                  <>
                    {' · '}
                    <span data-probe-last>{lastLine}</span>
                  </>
                ) : null}
                {next && next.tone === 'normal' ? (
                  <>
                    {' · '}
                    <span data-probe-next={next.tone}>{next.text}</span>
                  </>
                ) : null}
                {probedUnused ? (
                  // 没用途在用的路由点立即探测（#1630）：灰的「未被用途使用」不变，结论写在小字里，不画红
                  <span data-probed-unused={probe?.state}>
                    {' · '}
                    {probe?.state === 'ok' ? '探过：通' : '探过：不通'}
                  </span>
                ) : null}
              </span>
            </Text>
          </div>
          {/* 要人注意的：退避、检测中断（不截断）、疑似换模型、账号池毛病、不通的原文（截断，整句悬停） */}
          {next && next.tone !== 'normal' ? (
            <div data-probe-next={next.tone}>
              <Text
                size="meta"
                tone={next.tone === 'fail' ? 'danger' : 'warning'}
                strong={next.tone === 'fail'}
              >
                {next.text}
              </Text>
            </div>
          ) : null}
          {kind === 'degraded' ? (
            <Text size="meta" tone="warning">
              {routeStateLabel.degraded}
            </Text>
          ) : null}
          {problem ? <PoolProblemLine problem={problem} /> : null}
          {!open && probe?.detail && (failed || kind === 'degraded') ? (
            <Text size="meta" tone={failed ? 'danger' : 'warning'} truncate title={probe.detail}>
              {probe.detail}
            </Text>
          ) : null}
        </Stack>
      }
      details={
        <Stack gap="md">
          <div data-route-why title={why}>
            <Text size="meta" tone="muted">
              {why}
            </Text>
          </div>
          {active ? <Notice tone={active.why ? 'stall' : 'info'}>{activityText(active, now)}</Notice> : null}
          {failure ? (
            <Notice tone="fail">
              {formatClock(failure.requestedAt)} {sourceText(failure) ?? '点的立即探测'}没成：
              {failure.why ?? '没写原因'}
            </Notice>
          ) : null}
          <Descriptions columns={2} items={facts} />
          <Stack gap="sm">
            <Text size="meta" tone="muted">
              {probe?.state === 'failed' ? '失败原因（原文）' : '原文'}
            </Text>
            <Code block>{probe ? (probe.detail ?? '（探针没写原文）') : '（还没有结论）'}</Code>
          </Stack>
          {quotaCell ? (
            <Stack gap="sm">
              <Text size="meta" tone="muted">
                响应原文
              </Text>
              <div data-field="quota-response">
                <Code block>{quotaCell.responseText ?? '（没拿到）'}</Code>
              </div>
            </Stack>
          ) : null}
          <Stack direction="horizontal" gap="md" align="center" wrap>
            <Button
              size="xs"
              variant="outline"
              disabledReason={probeReason}
              title="让引擎现在就探这一条"
              onClick={onProbe}
            >
              立即探测
            </Button>
            <Button size="xs" variant="text" onClick={onPick}>
              看最近一次
            </Button>
          </Stack>
        </Stack>
      }
    />
  );
}
