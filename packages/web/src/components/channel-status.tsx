// 渠道卡（#1087）：每个渠道一张卡，一眼看通不通、排第几、不通了顺延到谁。渠道状态页（/routing/status）左栏用 ChannelList；
// 路由页（/routing）顶上只放一行 ChannelStrip 指过去——同一个渠道只在渠道状态页细看，不在两页各画一份（驾驶舱改版 2026-10-07）。
// 近 60 次格子是探针真历史（#1139）：一次探针一格，绿通过、红不通、黄没探。均耗时和可用率按这 60 格算。
// 改这里之前必须知道：
// - 绿灯只表示本节点最近一轮抽测通过；上次探超过「探测间隔 + 3 分钟」就改成「检测中断」，不拿旧绿灯装没事。
// - 排序、顺延、运行中失败、状态怎么并都在 lib/channel-status.ts；这里只画，不再判。
// - 渠道名用目录里公开的名字；渠道下的上游模型串不露。
// - 库读不到写「没查成」，不画空格子冒充没有历史。空格子只在读成了、次数不够 60 时补位。

import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router';
import type { ProbeHistoryCell, ProbeHistoryChannel } from '../api/types';
import type { ChannelCard } from '../lib/channel-status';
import { formatAgo, formatClock, formatIn } from '../lib/format';
import {
  formatAvailability,
  formatProbeMs,
  PROBE_RESULT_BG,
  PROBE_RESULT_WORD,
} from '../lib/probe-history-view';
import type { Failover } from '../lib/provider-status';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';
import { StatusChip, StatusDot } from './status';
import { Badge } from './ui/badge';

/** 渠道卡上的探针历史：读不到和还没有是两回事。 */
export type ChannelHistory =
  | { state: 'loading' }
  | { state: 'unreadable'; why: string }
  | { state: 'ok'; channels: readonly ProbeHistoryChannel[]; latestByRoute: readonly ProbeHistoryCell[] };

/**
 * 运行中失败的渠道（#1118）：为什么不可用、顺延到谁、下次探测。卡上用紧凑版（原因最多两行），右边详情用完整版。
 * 「顺延到谁」没有的两种情况分开写：还没派出去（没有新的活触发选路）、没有别的渠道可派。
 */
export function FailoverNote({
  failover,
  now,
  compact,
}: {
  failover: Failover;
  now: number;
  compact?: boolean;
}) {
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

/** 渠道状态页左栏：按顺位排的渠道卡，点一张右边看这个渠道的每条路由。格子点开看那一次。 */
export function ChannelList({
  cards,
  selected,
  probing,
  now,
  history,
  activeCellId,
  onPick,
  onPickCell,
}: {
  cards: readonly ChannelCard[];
  selected: string | undefined;
  /** 此刻有路由在立即探测的渠道。 */
  probing: ReadonlySet<string>;
  now: number;
  history: ChannelHistory;
  /** 右边正在看的那一次。只高亮它所在的那张卡上的格子。 */
  activeCellId: number | undefined;
  onPick: (channelId: string) => void;
  onPickCell: (channelId: string, cellId: number) => void;
}) {
  return (
    <ol aria-label="渠道状态" className="space-y-2">
      {cards.map((c) => (
        <ChannelRow
          key={c.channel.id}
          card={c}
          now={now}
          selected={c.channel.id === selected}
          probing={probing.has(c.channel.id)}
          history={history}
          activeCellId={activeCellId}
          onPick={() => onPick(c.channel.id)}
          onPickCell={onPickCell}
        />
      ))}
    </ol>
  );
}

function ChannelRow({
  card: c,
  now,
  selected,
  probing,
  history,
  activeCellId,
  onPick,
  onPickCell,
}: {
  card: ChannelCard;
  now: number;
  selected: boolean;
  probing: boolean;
  history: ChannelHistory;
  activeCellId: number | undefined;
  onPick: () => void;
  onPickCell: (channelId: string, cellId: number) => void;
}) {
  const down = c.state === 'down' && !c.interrupted;
  const quiet = c.state === 'idle' || c.state === 'off';
  const dot: Tone = quiet ? 'stop' : c.tone;
  const meta = [
    c.probedAt ? `${formatAgo(c.probedAt, now)}探的` : quiet ? undefined : '探针还没看过',
    c.deadRoutes > 0 && c.activeRoutes > 1 ? `${c.deadRoutes}/${c.activeRoutes} 条路不通` : undefined,
  ].filter((x): x is string => x !== undefined);
  return (
    <li
      data-channel={c.channel.id}
      data-state={c.interrupted ? 'interrupted' : c.state}
      className={cn(
        'rounded-lg border bg-card shadow-card-edge transition-colors hover:border-border-strong',
        down && 'border-st-fail/40 bg-st-fail/5',
        c.interrupted && 'border-st-stall/50 bg-st-stall/5',
        quiet && 'bg-muted/30',
        selected && 'border-border-strong ring-2 ring-ring/30',
      )}
    >
      <button
        type="button"
        onClick={onPick}
        aria-current={selected ? 'true' : undefined}
        className="block w-full px-3.5 py-3 text-left"
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span
            title={c.rank ? `顺位第 ${c.rank}` : '没排进顺位'}
            className="num grid size-5 shrink-0 place-items-center rounded-full bg-foreground/10 text-caption font-medium"
          >
            {c.rank ?? '–'}
            <span className="sr-only">{c.rank ? `顺位第 ${c.rank}` : '没排进顺位'}</span>
          </span>
          <StatusDot tone={dot} />
          <span className={cn('text-sm font-semibold', quiet && 'text-muted-foreground')}>
            {c.channel.name}
          </span>
          <StatusChip tone={c.tone} label={c.label} className={cn(c.interrupted && 'font-semibold')} />
          {down && !c.failover ? (
            <Badge variant="outline" className="h-4 px-1 text-micro font-normal text-ink-fail">
              已禁用
            </Badge>
          ) : null}
          {probing ? (
            <span className="inline-flex items-center gap-1 text-caption text-ink-run">
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
              探测中
            </span>
          ) : null}
        </div>
        {meta.length > 0 ? (
          <p className="num mt-1.5 text-caption text-muted-foreground">{meta.join(' · ')}</p>
        ) : null}
        {c.interrupted ? (
          <p role="status" className="mt-1.5 text-sub font-medium text-ink-stall">
            检测中断：探针超过间隔没更新这个渠道，上次的结论不再当现状
            {c.probedAt ? `（${formatAgo(c.probedAt, now)}）` : null}
          </p>
        ) : null}
        {c.fallback ? <p className="mt-1.5 text-sub text-ink-fail">{c.fallback}</p> : null}
        {c.failover ? (
          <FailoverNote failover={c.failover} now={now} compact />
        ) : c.reason ? (
          <p className="mt-1 line-clamp-2 break-words text-caption text-muted-foreground" title={c.reason}>
            {c.reason}
          </p>
        ) : null}
      </button>
      <HistoryBlock
        channelId={c.channel.id}
        history={history}
        activeCellId={activeCellId}
        onPickCell={onPickCell}
      />
    </li>
  );
}

/** 不够 60 格时左边的空位。键按「第几格」写死，不拿数组下标当键。 */
function emptySlotKeys(channelId: string, count: number): string[] {
  const keys: string[] = [];
  for (let n = 1; n <= count; n++) keys.push(`${channelId}:empty:${n}`);
  return keys;
}

/** 卡下沿：均耗时、可用率，加近 60 次格子。读不到不画格子。 */
function HistoryBlock({
  channelId,
  history,
  activeCellId,
  onPickCell,
}: {
  channelId: string;
  history: ChannelHistory;
  activeCellId: number | undefined;
  onPickCell: (channelId: string, cellId: number) => void;
}) {
  if (history.state === 'loading') {
    return (
      <p data-history="loading" className="px-3.5 pb-3 text-caption text-muted-foreground">
        正在读探针历史
      </p>
    );
  }
  if (history.state === 'unreadable') {
    return (
      <p role="alert" data-history="unreadable" className="px-3.5 pb-3 text-caption text-ink-fail">
        {history.why}
      </p>
    );
  }
  const strip = history.channels.find((item) => item.channelId === channelId);
  const cells = (strip?.cells ?? []).slice(-PROBE_HISTORY_SLOTS);
  const empties = emptySlotKeys(channelId, PROBE_HISTORY_SLOTS - cells.length);
  return (
    <div data-history="strip" className="px-3.5 pb-3">
      <p data-history-stats className="num text-caption text-muted-foreground">
        均耗时 {formatProbeMs(strip?.avgDurationMs ?? null)} · 可用率{' '}
        {formatAvailability(strip?.passed ?? 0, strip?.attempted ?? 0)}
      </p>
      <div className="mt-1.5 flex h-5 gap-px">
        {empties.map((slot) => (
          <span
            key={slot}
            data-result="empty"
            className="h-full min-w-0 flex-1 rounded-[2px] border border-dashed border-foreground/15"
          />
        ))}
        {cells.map((cell) => {
          const word = PROBE_RESULT_WORD[cell.result];
          const on = cell.id === activeCellId;
          return (
            <button
              key={cell.id}
              type="button"
              data-result={cell.result}
              data-cell={cell.id}
              aria-pressed={on}
              title={`${formatClock(cell.probedAt)} ${cell.routeId} ${word.label} ${formatProbeMs(cell.durationMs, cell.result)}`}
              onClick={() => onPickCell(channelId, cell.id)}
              className={cn(
                'h-full min-w-0 flex-1 rounded-[2px]',
                PROBE_RESULT_BG[cell.result],
                on && 'ring-2 ring-foreground',
              )}
            >
              <span className="sr-only">
                {formatClock(cell.probedAt)} {cell.routeId} {word.label}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-micro text-faint">
        {cells.length === 0 ? '还没有探针历史 · ' : null}绿通过 · 红不通 · 黄没探
      </p>
    </div>
  );
}

/** 路由页顶上的一行：每个渠道一个小圆点加名字，点过去看渠道状态页（原文、立即探测都在那里）。 */
export function ChannelStrip({ cards, now }: { cards: readonly ChannelCard[]; now: number }) {
  const bad = cards.filter((c) => c.state === 'down' && !c.interrupted).length;
  return (
    <nav
      aria-label="渠道一览"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-2.5 shadow-card-edge"
    >
      <span className="text-sub font-semibold">渠道</span>
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {cards.map((c) => {
          const quiet = c.state === 'idle' || c.state === 'off';
          return (
            <li
              key={c.channel.id}
              data-channel={c.channel.id}
              data-state={c.interrupted ? 'interrupted' : c.state}
            >
              <Link
                to={`/routing/status?p=${encodeURIComponent(c.channel.id)}`}
                title={[c.label, c.probedAt ? `${formatAgo(c.probedAt, now)}探的` : undefined, c.reason]
                  .filter(Boolean)
                  .join(' · ')}
                className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sub hover:bg-muted"
              >
                <StatusDot tone={quiet ? 'stop' : c.tone} />
                <span className={cn(quiet && 'text-muted-foreground')}>{c.channel.name}</span>
                {c.state === 'ok' && !c.interrupted ? null : (
                  <span
                    className={cn('text-caption', quiet ? 'text-muted-foreground' : 'text-foreground/80')}
                  >
                    {c.label}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ol>
      <Link
        to="/routing/status"
        className="ml-auto inline-flex items-center gap-0.5 text-caption text-muted-foreground underline-offset-2 hover:underline"
      >
        {bad > 0 ? `${bad} 个渠道暂不可用，` : ''}看原文、立即探测
        <ArrowRight className="size-3" />
      </Link>
    </nav>
  );
}
