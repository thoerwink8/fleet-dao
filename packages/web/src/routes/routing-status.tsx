// 渠道状态页（#1087；近 60 次真历史 #1139）：每个渠道一张卡，格子是每次探针，点开看那一次的耗时和原文。
// 左栏按顺位排的渠道卡，右边选中渠道的这一次，再往下是每条路由：最近一次结论、耗时、时刻、失败原因原文，
// 每条一个「立即探测」，顶上「全部立即探测」。
// 改这里之前必须知道：
// - 通不通、排第几、运行中失败、检测中断都在 lib/channel-status.ts 判，和路由页顶上那一行同一份；这里只画。
// - 「立即探测」点下去由法国引擎接手（engine/src/jobs/route-probe-now.ts），走到哪由后端从操作记录现算；页面在探的时候
//   每 3 秒重拉一次，探完自己把路由目录也重拉（api/client.tsx 的 useRouteProbeStatus）。
// - 探不了要说清是哪样：引擎关着、没连上、没查成、没人接手、引擎说没探成，各有一句，不显示成「通」或空白。
// - 近 60 次来自探针历史（route_probe_history），本渠道所有路由按时间排，一次一格。没探和不通颜色分开。
//   均耗时、可用率按这 60 格算。库读不到写「没查成」，不拿空格子冒充没有。引擎关着这一份照样读。

import { PROBE_HISTORY_SLOTS, ROUTE_PROBE_EVERY_MINUTES, routeProbeEveryMinutes } from '@fleet-dao/shared';
import { LoaderCircle, Radar, SatelliteDish } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { brand } from '#brand';
import {
  errorText,
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
import { type ChannelHistory, ChannelList, FailoverNote } from '../components/channel-status';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { StatusChip, StatusDot } from '../components/status';
import { Button } from '../components/ui/button';
import { buildChannelCards, type ChannelCard, channelProbeInterrupted } from '../lib/channel-status';
import { formatAgo, formatClock, formatDateTime, formatIn } from '../lib/format';
import { useNow } from '../lib/hooks';
import { formatProbeMs, PROBE_RESULT_BG, PROBE_RESULT_WORD } from '../lib/probe-history-view';
import { activeFor, activityText, isActive, lastFailureFor, probeSeconds } from '../lib/route-probe';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('渠道状态') }];
}

const DESCRIPTION =
  '每个渠道通不通、不通为什么。点「立即探测」让法国引擎现在就探，不用等下一轮（Claude 订阅 15 分钟一轮；Mirasim、Cursor、Grok 探通后 2 小时一轮）。';

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
  return { cell: cells[cells.length - 1], routeMissing: false };
}

export default function RoutingStatus() {
  const routing = useRouting();
  const layers = useRoutingLayers();
  const probe = useRouteProbeStatus();
  const historyQuery = useProbeHistory();
  const probeNow = useRouteProbeNow();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const [manualPick, setManualPick] = useState<string | null>(null);
  const [cellPick, setCellPick] = useState<{ channelId: string; cellId: number } | null>(null);
  const [routePick, setRoutePick] = useState<{ channelId: string; routeId: string } | null>(null);

  const cards = useMemo(
    () => (routing.data && layers.data ? buildChannelCards(routing.data, layers.data, now) : []),
    [routing.data, layers.data, now],
  );
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

  const wanted = manualPick ?? params.get('p');
  const picked = cards.some((c) => c.channel.id === wanted) ? wanted : cards[0]?.channel.id;
  const current = cards.find((c) => c.channel.id === picked);
  const focus = current ? resolveProbe(current.channel.id, history, cellPick, routePick) : undefined;
  const pickChannel = (id: string) => {
    setManualPick(id);
    setCellPick(null);
    setRoutePick(null);
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
  const open = cards.filter((c) => c.state !== 'off' && c.state !== 'idle');
  // 三样分开数：能用、暂不可用、不知道（还没探到、按量不探、检测中断）——不知道的不算进能用，也不算坏
  const okCount = open.filter((c) => (c.state === 'ok' || c.state === 'partial') && !c.interrupted).length;
  const downCount = open.filter((c) => c.state === 'down' && !c.interrupted).length;
  const unknownCount = open.length - okCount - downCount;
  const allActive = requests.some((r) => isActive(r) && r.routeIds === undefined);
  const fire = (routeIds?: string[]) => probeNow.mutate(routeIds ? { routeIds } : {});

  return (
    <Page
      title="渠道状态"
      description={DESCRIPTION}
      actions={
        <>
          <StatusChip tone="done" label={`${okCount} 个能用`} />
          {downCount > 0 ? <StatusChip tone="fail" label={`${downCount} 个暂不可用`} /> : null}
          {unknownCount > 0 ? <StatusChip tone="stall" label={`${unknownCount} 个不知道`} /> : null}
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
        <div className="min-w-0">
          <ChannelList
            cards={cards}
            selected={picked ?? undefined}
            probing={probing}
            now={now}
            history={history}
            activeCellId={focus?.cell?.id}
            onPick={pickChannel}
            onPickCell={pickCell}
          />
          <ul className="mt-3 space-y-1 text-caption text-muted-foreground">
            <li>绿灯只表示本节点最近一轮抽测通过，不保证每次使用都正常。</li>
            <li>上次探测超过「探测间隔 + 3 分钟」还没更新，就显示「检测中断」，不拿旧绿灯掩盖中断。</li>
            <li>
              每个用途排哪些模型、能不能派，看{' '}
              <Link to="/routing" className="underline underline-offset-2">
                路由
              </Link>
              。
            </li>
          </ul>
        </div>
        <div className="min-w-0">
          {current ? (
            <ChannelDetail
              card={current}
              routes={allRoutes.filter((r) => r.channelId === current.channel.id)}
              models={routing.data.models}
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
          ) : null}
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
    if (recent.state === 'done') {
      const count = (o: string[]) => recent.results.filter((x) => o.includes(x.outcome)).length;
      lines.push({
        key: recent.requestId,
        tone: count(['failed']) > 0 ? 'fail' : 'done',
        text: `${at} 的立即探测探完了：通过 ${count(['ok'])} · 不通 ${count(['failed'])} · 没探 ${count([
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
        text: `${at} 的立即探测没成：${recent.why ?? '没写原因'}`,
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

function ChannelDetail({
  card,
  routes,
  models,
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
  // 探过的在前、没探过的在后；同样的按编号
  const sorted = [...routes].sort(
    (a, b) => (a.probe ? 0 : 1) - (b.probe ? 0 : 1) || a.id.localeCompare(b.id),
  );
  const idle = sorted.filter((r) => !activeFor(requests, r.id)).map((r) => r.id);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
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
      {card.failover ? <FailoverNote failover={card.failover} now={now} /> : null}
      <ProbeFocus
        history={history}
        channelId={card.channel.id}
        routes={routes}
        models={models}
        cell={focus?.cell}
        routeMissing={focus?.routeMissing ?? false}
        now={now}
        onPickCell={onPickCell}
      />
      {sorted.length === 0 ? (
        <p className="text-sub text-muted-foreground">这个渠道下一条路由都没有。</p>
      ) : (
        <ol aria-label={`${card.channel.name} 的路由`} className="space-y-3">
          {sorted.map((r) => (
            <RouteRow
              key={r.id}
              route={r}
              model={models.find((m) => m.id === r.modelId)}
              requests={requests}
              blocked={blocked}
              busy={busy}
              now={now}
              picked={focus?.cell?.routeId === r.id}
              onPick={() => onPickRoute(r.id)}
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
  model,
  requests,
  blocked,
  busy,
  now,
  picked,
  onPick,
  onProbe,
}: {
  route: Route;
  model: Model | undefined;
  requests: readonly RouteProbeRequest[];
  blocked: string | undefined;
  busy: boolean;
  now: number;
  picked: boolean;
  onPick: () => void;
  onProbe: () => void;
}) {
  const active = activeFor(requests, r.id);
  const failure = lastFailureFor(requests, r);
  const probe = r.probe;
  const word = probe ? STATE_WORD[probe.state] : { label: '还没探到', tone: 'stop' as Tone };
  const stale = probe ? channelProbeInterrupted({ probedAt: probe.at, hostId: r.hostId }, now) : false;
  const seconds = probeSeconds(r, requests);
  const every = routeProbeEveryMinutes(r.hostId);
  const nextAt = probe
    ? new Date(
        Date.parse(probe.at) + (probe.state === 'ok' ? every : ROUTE_PROBE_EVERY_MINUTES) * 60_000,
      ).toISOString()
    : undefined;
  return (
    <li
      data-route={r.id}
      data-probe={active ? active.state : (probe?.state ?? 'none')}
      className={cn(
        'rounded-lg border px-3.5 py-3',
        probe?.state === 'failed' && !active && 'border-st-fail/40',
        picked && 'ring-2 ring-ring/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot tone={active ? 'run' : word.tone} />
        <span className="text-sm font-semibold">{model?.displayName ?? r.modelId}</span>
        <span className="num truncate text-caption text-muted-foreground" title={r.id}>
          {r.id}
        </span>
        {active ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-st-run/10 px-1.5 text-[11px] font-medium leading-5 text-ink-run">
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
            {active.state === 'running' ? '探测中' : '排队中'}
          </span>
        ) : (
          <StatusChip tone={word.tone} label={word.label} />
        )}
        {stale && !active ? <StatusChip tone="stall" label="结论过期" /> : null}
        <button
          type="button"
          onClick={onPick}
          className="text-caption text-muted-foreground underline-offset-2 hover:underline"
        >
          看最近一次
        </button>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={blocked !== undefined || active !== undefined || busy}
          title={blocked ?? (active ? '已经在探了' : '让引擎现在就探这一条')}
          onClick={onProbe}
        >
          {active ? <LoaderCircle className="animate-spin" aria-hidden /> : <Radar aria-hidden />}
          立即探测
        </Button>
      </div>
      {active ? (
        <p className={cn('mt-1.5 text-caption', active.why ? 'text-ink-stall' : 'text-ink-run')}>
          {activityText(active, now)}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="mt-1.5 text-caption text-ink-fail">
          {formatClock(failure.requestedAt)} 点的立即探测没成：{failure.why ?? '没写原因'}
        </p>
      ) : null}
      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-caption sm:grid-cols-4">
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
            probe?.state === 'failed' ? 'text-ink-fail' : 'text-muted-foreground',
          )}
        >
          {probe ? (probe.detail ?? '（探针没写原文）') : '（还没有结论）'}
        </pre>
      </div>
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

/** 右边：正在看的那一次，和这条带上最近 60 次（新的在上）。 */
function ProbeFocus({
  history,
  channelId,
  routes,
  models,
  cell,
  routeMissing,
  now,
  onPickCell,
}: {
  history: ChannelHistory;
  channelId: string;
  routes: readonly Route[];
  models: readonly Model[];
  cell: ProbeHistoryCell | undefined;
  routeMissing: boolean;
  now: number;
  onPickCell: (cellId: number) => void;
}) {
  if (history.state === 'loading') {
    return (
      <p data-history="loading" className="mb-3 text-sub text-muted-foreground">
        正在读探针历史
      </p>
    );
  }
  if (history.state === 'unreadable') {
    return (
      <p role="alert" data-history="unreadable" className="mb-3 text-sub text-ink-fail">
        {history.why}
      </p>
    );
  }
  const strip = history.channels.find((item) => item.channelId === channelId);
  const cells = (strip?.cells ?? []).slice(-PROBE_HISTORY_SLOTS);
  return (
    <div className="mb-4">
      <section
        aria-label="这一次"
        data-probe-detail={cell?.id ?? 'none'}
        className="rounded-lg border px-3.5 py-3"
      >
        {routeMissing ? (
          <p>这条路由还没有探针历史</p>
        ) : cell ? (
          <ProbeOnce cell={cell} routes={routes} models={models} now={now} />
        ) : (
          <p>还没有探针历史</p>
        )}
      </section>
      {cells.length > 0 ? (
        <ol aria-label="最近状态（60）" className="mt-2 max-h-52 space-y-0.5 overflow-auto">
          {[...cells].reverse().map((item) => (
            <li key={item.id}>
              <button
                type="button"
                data-cell={item.id}
                data-result={item.result}
                aria-current={item.id === cell?.id ? 'true' : undefined}
                onClick={() => onPickCell(item.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-caption hover:bg-muted',
                  item.id === cell?.id && 'bg-muted',
                )}
              >
                <span className={cn('size-2 shrink-0 rounded-[2px]', PROBE_RESULT_BG[item.result])} />
                <span className="num">{formatDateTime(item.probedAt)}</span>
                <span className="min-w-0 flex-1 truncate">{item.routeId}</span>
                <span className="num">{formatProbeMs(item.durationMs, item.result)}</span>
                <span>{PROBE_RESULT_WORD[item.result].label}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ProbeOnce({
  cell,
  routes,
  models,
  now,
}: {
  cell: ProbeHistoryCell;
  routes: readonly Route[];
  models: readonly Model[];
  now: number;
}) {
  const route = routes.find((item) => item.id === cell.routeId);
  const model = models.find((item) => item.id === route?.modelId);
  const who = model ? `${model.displayName} · ${cell.routeId}` : cell.routeId;
  const word = PROBE_RESULT_WORD[cell.result];
  const resultText =
    cell.result === 'passed' ? word.label : `${word.label}：${cell.failureReason ?? '（没写原因）'}`;
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-caption sm:grid-cols-3">
        <Fact label="时刻">
          <span className="num">
            {formatDateTime(cell.probedAt)}（{formatAgo(cell.probedAt, now)}）
          </span>
        </Fact>
        <Fact label="路由">{who}</Fact>
        <Fact label="耗时">
          <span className="num">{formatProbeMs(cell.durationMs, cell.result)}</span>
        </Fact>
      </dl>
      <p
        data-field="result"
        className={cn('mt-2 break-words text-sub', cell.result === 'failed' && 'text-ink-fail')}
      >
        {resultText}
      </p>
      <ProbeText
        label="请求原文（REQUEST）"
        field="request"
        text={cell.requestText}
        empty="（没发出去）"
        failed={false}
      />
      <ProbeText
        label="响应原文（RESPONSE）"
        field="response"
        text={cell.responseText}
        empty="（没拿到）"
        failed={cell.result === 'failed'}
      />
    </>
  );
}

function ProbeText({
  label,
  field,
  text,
  empty,
  failed,
}: {
  label: string;
  field: string;
  text: string | null;
  empty: string;
  failed: boolean;
}) {
  return (
    <div className="mt-2.5">
      <div className="mb-1 text-caption text-muted-foreground">{label}</div>
      <pre
        data-field={field}
        className={cn(
          'max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-micro',
          failed ? 'text-ink-fail' : 'text-muted-foreground',
        )}
      >
        {text ?? empty}
      </pre>
    </div>
  );
}
