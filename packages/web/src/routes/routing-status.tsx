// 渠道状态页（#1087）：左边一排「按供应商（渠道）聚合」的卡，每张卡给近 60 次健康柱条、平均耗时、
// 可用率、当前状态；点一张卡右边打开看详情（每一条路由最近一次探针的 request/response 原文）。
//
// 改这里之前必须知道：
// - 现在库里没存探针历史（只有最近一次结论），「近 60 次」是把同一个渠道下几条路的最近结论铺成 60 格；
//   真历史接入后换成真历史（lib/provider-status.ts 的注释写了形状）。
// - 绿灯只表示本节点最近一轮抽测通过；上次探超过间隔加 3 分钟就改「检测中断」（沿用 buildChannelCards 的判法），
//   不拿旧绿灯装没事。这一页照 nowcoding.ai/service-status 的样式做（左卡右详情）。
// - 演示版（mock）走同一个函数，卡长得一样。

import { Activity, ArrowRight, SatelliteDish } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useRouting, useRoutingLayers } from '../api/client';
import type { Route } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { StatusChip, StatusDot } from '../components/status';
import { Badge } from '../components/ui/badge';
import { formatAgo, formatClock, formatIn } from '../lib/format';
import { useNow } from '../lib/hooks';
import {
  buildProviderCards,
  type Failover,
  type ProviderCard,
  summaryLine,
  TICKS_PER_CARD,
  type Tick,
} from '../lib/provider-status';
import { type Tone, toneBg, toneText } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('渠道状态') }];
}

const DESCRIPTION =
  '每个渠道（供应商）一张卡，近 60 次的健康结果一眼看：通 / 不通 / 还没探到。点一张卡右边看每一条路由最近一次探针的 request/response 原文。现在的「近 60 次」是同一个渠道下几条路由的最近一次结论铺开的（真历史还没在库里）；绿灯只表示本节点最近一轮抽测通过。每 30 秒自动刷新。';

const tickTone: Record<Tick['kind'], Tone> = { ok: 'done', partial: 'stall', down: 'fail', off: 'stop' };

function TickBars({ ticks }: { ticks: readonly Tick[] }) {
  return (
    <div role="img" aria-label={`近 ${TICKS_PER_CARD} 次健康结果`} className="flex h-6 items-end gap-[2px]">
      {ticks.map((t, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 每张卡固定 60 格、顺序不动，「位置 + 这一刻的 routeId」是这一格唯一的身份（同一格里的 routeId 前后会换，单独用它不行）。
          key={`${i}:${t.routeId || 'off'}`}
          title={t.at ? `${formatAgo(t.at, Date.now())} · ${t.text || '—'}` : '还没探到'}
          className={cn(
            'h-full w-[3px] shrink-0 rounded-sm',
            t.kind === 'off' ? 'bg-foreground/12' : toneBg[tickTone[t.kind]],
          )}
        />
      ))}
    </div>
  );
}

/**
 * 运行中失败的渠道（#1118）：为什么不可用、顺延到谁、下次探测。卡上用紧凑版（原因最多两行），右边详情用完整版。
 * 「顺延到谁」没有的两种情况分开写：还没派出去（没有新的活触发选路）、没有别的渠道可派。
 */
function FailoverNote({ failover, now, compact }: { failover: Failover; now: number; compact?: boolean }) {
  const next = failover.nextProbeAt;
  return (
    <dl
      data-failover
      className={cn(
        'grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-caption',
        compact ? 'mt-2 text-muted-foreground' : 'mb-3 rounded-md border bg-muted/40 px-3 py-2.5 text-sub',
      )}
    >
      <dt className="text-ink-fail">为什么不可用</dt>
      <dd data-field="reason" className={cn('min-w-0 break-words', compact && 'line-clamp-2')}>
        {failover.reason}
        {failover.flaggedAt ? `（${formatClock(failover.flaggedAt)} 标上的）` : null}
      </dd>
      <dt>顺延到谁</dt>
      <dd data-field="fallback">
        {failover.fallback
          ? `${failover.fallback.channelName} · ${failover.fallback.modelName}`
          : '还没派出去：没有别的渠道可顺延，或还没有新的活来选路'}
      </dd>
      <dt>下次探测</dt>
      <dd data-field="next-probe" className="num">
        {next
          ? `${formatClock(next)}（${formatIn(next, now)}）`
          : `下一轮探针（约每 ${failover.probeEveryMinutes} 分钟一轮）`}
        {failover.failedRouteId
          ? ` · 探通 ${failover.failedRouteId} 才恢复`
          : ' · 探通渠道下任一条路由就恢复'}
      </dd>
    </dl>
  );
}

function ProviderRow({
  card,
  selected,
  now,
  onPick,
}: {
  card: ProviderCard;
  selected: boolean;
  now: number;
  onPick: () => void;
}) {
  const tone: Tone =
    card.current.kind === 'ok'
      ? 'done'
      : card.current.kind === 'partial'
        ? 'stall'
        : card.current.kind === 'down'
          ? 'fail'
          : 'stop';
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        aria-current={selected ? 'true' : undefined}
        data-provider={card.channel.id}
        data-state={card.current.kind}
        className={cn(
          'block w-full rounded-lg border bg-card px-3.5 py-3 text-left shadow-card-edge transition-colors hover:border-border-strong',
          selected && 'border-border-strong bg-muted/60',
        )}
      >
        <div className="flex items-center gap-2">
          <StatusDot tone={tone} />
          <span className={cn('text-sm font-semibold', !card.enabled && 'text-muted-foreground')}>
            {card.channel.name}
          </span>
          <StatusChip tone={tone} label={card.current.label} className="ml-auto" />
        </div>
        <div className="mt-2">
          <TickBars ticks={card.ticks} />
        </div>
        <div className="num mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-muted-foreground">
          {card.avgLatencySec !== undefined ? <span>均耗时 {card.avgLatencySec.toFixed(1)}s</span> : null}
          {card.availability !== undefined ? (
            <span>可用率 {(card.availability * 100).toFixed(0)}%</span>
          ) : (
            <span>探针还没看过</span>
          )}
          {card.probedCount > 0 && card.downCount > 0 ? (
            <span className="text-ink-fail">{card.downCount} 条不通</span>
          ) : null}
        </div>
        {card.failover ? <FailoverNote failover={card.failover} now={now} compact /> : null}
      </button>
    </li>
  );
}

function RouteDetailRow({ route }: { route: Route }) {
  const probe = route.probe;
  const tone: Tone = probe
    ? probe.state === 'ok'
      ? 'done'
      : probe.state === 'failed'
        ? 'fail'
        : 'stall'
    : 'stop';
  return (
    <li data-route={route.id} className="border-b px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot tone={tone} />
        <span className="text-sub font-medium">{route.id}</span>
        <StatusChip
          tone={tone}
          label={
            probe
              ? probe.state === 'ok'
                ? '通过'
                : probe.state === 'failed'
                  ? '调用异常'
                  : probe.state === 'skipped'
                    ? '本轮没探'
                    : '未知'
              : '还没探到'
          }
        />
        {!route.alive ? (
          <Badge variant="outline" className="h-4 px-1 text-micro font-normal text-ink-fail">
            暂不可用
          </Badge>
        ) : null}
        {probe ? (
          <span className="num ml-auto text-caption text-muted-foreground">
            {formatAgo(probe.at, Date.now())}
          </span>
        ) : null}
      </div>
      {probe ? (
        <div className="mt-2 space-y-1">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-micro text-muted-foreground">
            {probe.detail ?? '（没有原文）'}
          </pre>
        </div>
      ) : (
        <p className="mt-1 text-caption text-muted-foreground">探针还没看过这条路由。</p>
      )}
    </li>
  );
}

function Detail({ card, now }: { card: ProviderCard; now: number }) {
  const tone: Tone =
    card.current.kind === 'ok'
      ? 'done'
      : card.current.kind === 'partial'
        ? 'stall'
        : card.current.kind === 'down'
          ? 'fail'
          : 'stop';
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {card.channel.name}
          <Badge variant="outline" className="h-4 px-1 text-micro font-normal">
            供应商
          </Badge>
        </span>
      }
      description={
        `近 ${card.ticks.filter((t) => t.kind !== 'off').length} 次结论：` +
        `通过 ${card.okCount} 次 · 不通 ${card.downCount} 次 · 没探到 ${Math.max(
          0,
          card.routes.length - card.probedCount,
        )} 次` +
        (card.avgLatencySec !== undefined ? ` · 均耗时 ${card.avgLatencySec.toFixed(1)}s` : '') +
        (card.availability !== undefined ? ` · 可用率 ${(card.availability * 100).toFixed(0)}%` : '')
      }
      actions={<StatusChip tone={tone} label={card.current.label} />}
    >
      {card.failover ? <FailoverNote failover={card.failover} now={now} /> : null}
      {!card.failover && card.current.kind !== 'ok' && 'reason' in card.current && card.current.reason ? (
        <p className={cn('mb-3 text-sub', toneText[tone])}>{card.current.reason}</p>
      ) : null}
      <div className="overflow-hidden rounded-lg border">
        <ol aria-label={`${card.channel.name} 的路由`}>
          {card.routes.length === 0 ? (
            <li className="px-3 py-3 text-sub text-muted-foreground">这个渠道下一条路由都没有。</li>
          ) : (
            card.routes.map((r) => <RouteDetailRow key={r.id} route={r} />)
          )}
        </ol>
      </div>
      <p className="mt-3 text-caption text-muted-foreground">
        探针多久一轮：Claude 订阅类 15 分钟；cursor-agent、grok、mirasim 这种按一次的成本放慢到 2 小时
        （design 第九节「路由探针」）。按量计费的渠道不自动探。
      </p>
    </Panel>
  );
}

export default function RoutingStatus() {
  const routing = useRouting();
  const layers = useRoutingLayers();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const [manualPick, setManualPick] = useState<string | null>(null);

  const cards = useMemo(
    () => (routing.data ? buildProviderCards(routing.data, layers.data) : []),
    [routing.data, layers.data],
  );

  if (routing.error) {
    return (
      <Page title="渠道状态" description={DESCRIPTION}>
        <LoadError what="渠道状态" error={routing.error} />
      </Page>
    );
  }
  if (routing.isLoading || !routing.data) {
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

  const picked =
    manualPick && cards.some((c) => c.channel.id === manualPick)
      ? manualPick
      : params.get('p') && cards.some((c) => c.channel.id === params.get('p'))
        ? (params.get('p') as string)
        : cards[0]?.channel.id;
  const current = cards.find((c) => c.channel.id === picked);
  const summary = summaryLine(cards);

  // 顶栏那一句「N / M 正常」：关掉的不算分母
  const summary_chip = (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusChip
        tone={summary.downNames.length === 0 ? 'done' : 'fail'}
        label={`${summary.ok} / ${summary.total} 正常`}
      />
      {layers.data && !layers.data.unavailable ? null : (
        <span className="text-caption text-muted-foreground">路由两层读不到</span>
      )}
      <span className="num text-caption text-muted-foreground">
        每 30 秒自动刷新 · {formatAgo(new Date().toISOString(), now)}
      </span>
    </div>
  );

  return (
    <Page title="渠道状态" description={DESCRIPTION} actions={summary_chip}>
      {layers.error ? (
        <div className="mb-3">
          <LoadError what="路由两层" error={layers.error} />
        </div>
      ) : null}
      <div className="grid items-start gap-4 xl:grid-cols-routing">
        <nav aria-label="供应商" className="min-w-0">
          <ul className="space-y-2">
            {cards.map((c) => (
              <ProviderRow
                key={c.channel.id}
                card={c}
                selected={c.channel.id === picked}
                now={now}
                onPick={() => {
                  setManualPick(c.channel.id);
                  setParams({ p: c.channel.id }, { replace: true, preventScrollReset: true });
                }}
              />
            ))}
          </ul>
          <p className="mt-3 text-caption text-muted-foreground">
            也看{' '}
            <Link to="/routing" className="underline underline-offset-2 inline-flex items-center gap-0.5">
              路由两层
              <ArrowRight className="size-3" />
            </Link>
            ：每个用途排哪些模型、模型走哪几条路、能不能派。
          </p>
        </nav>
        <div className="min-w-0">
          {current ? (
            <Detail card={current} now={now} />
          ) : (
            <Panel>
              <Empty icon={Activity} title="选一张卡" hint="从左边点一张供应商卡看明细" />
            </Panel>
          )}
        </div>
      </div>
    </Page>
  );
}
