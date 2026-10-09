// 渠道状态（#1087，重做 #1366）：渠道状态页左栏是一列折叠的摘要行（名字、状态、几条在线/故障/已关、最近探测时间），
// 点一行右边（手机上是整页）看这个渠道的每条路由、原文、立即探测；路由页顶上只放一行 ChannelStrip 指过去。
// 近 60 次格子是探针真历史（#1139）：一次探针一格，绿通过、红不通、黄没探。均耗时和可用率按这 60 格算，格子在详情里。
// 改这里之前必须知道：
// - 绿灯只表示本节点最近一轮抽测通过；上次探超过「探测间隔 + 3 分钟」就改成「检测中断」，不拿旧绿灯装没事。
// - 排序、顺延、运行中失败、状态怎么并都在 lib/channel-status.ts；状态种类（在线、故障、已关、未被用途使用……）在
//   lib/route-state.ts：这里只画，不再判。只有故障画红；已关、未使用、池暂停不是坏了，不画红。
// - 渠道名用目录里公开的名字；渠道下的上游模型串不露。
// - 库读不到写「没查成」，不画空格子冒充没有历史。空格子只在读成了、次数不够 60 时补位。

import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import { ChevronRight, LoaderCircle, Search } from 'lucide-react';
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
import { countsText, STATE_FILTERS, type StateFilter } from '../lib/route-state';
import { cn } from '../lib/utils';
import { StatusChip, StatusDot } from './status';

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
        'grid grid-cols-auto-fr gap-x-2 gap-y-0.5 text-caption',
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

/** 搜索框和状态筛选（全部 / 故障 / 已关 / 未使用），每一档带条数。 */
export function ChannelFilterBar({
  search,
  onSearch,
  filter,
  onFilter,
  counts,
}: {
  search: string;
  onSearch: (value: string) => void;
  filter: StateFilter;
  onFilter: (value: StateFilter) => void;
  counts: Record<StateFilter, number>;
}) {
  return (
    <div className="mb-2 space-y-2">
      <label className="relative block">
        <span className="sr-only">搜索渠道</span>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="搜渠道、模型、路由号"
          aria-label="搜索渠道"
          className="h-9 w-full rounded-lg border bg-card pl-8 pr-2.5 text-sub outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </label>
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
        <legend className="sr-only">按状态筛选</legend>
        {STATE_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            data-filter={f.id}
            onClick={() => onFilter(f.id)}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-caption transition-colors hover:bg-muted',
              filter === f.id && 'border-border-strong bg-muted font-medium',
              f.id === 'fault' && counts.fault > 0 && 'text-ink-fail',
            )}
          >
            {f.label}
            <span className="num text-muted-foreground">{counts[f.id]}</span>
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/** 渠道状态页左栏：一列折叠的摘要行（按给的顺序画），点一行右边看这个渠道的每条路由。 */
export function ChannelList({
  cards,
  selected,
  probing,
  now,
  onPick,
}: {
  cards: readonly ChannelCard[];
  selected: string | undefined;
  /** 此刻有路由在立即探测的渠道。 */
  probing: ReadonlySet<string>;
  now: number;
  onPick: (channelId: string) => void;
}) {
  return (
    <ol aria-label="渠道状态" className="space-y-1.5">
      {cards.map((c) => (
        <ChannelRow
          key={c.channel.id}
          card={c}
          now={now}
          selected={c.channel.id === selected}
          probing={probing.has(c.channel.id)}
          onPick={() => onPick(c.channel.id)}
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
  onPick,
}: {
  card: ChannelCard;
  now: number;
  selected: boolean;
  probing: boolean;
  onPick: () => void;
}) {
  const down = c.state === 'down' && !c.interrupted;
  // 已关、未被用途使用、下架：灰着，不是坏了
  const quiet = c.kind === 'off' || c.kind === 'unused' || c.kind === 'retired';
  const summary = [
    countsText(c.counts),
    c.probedAt ? `${formatAgo(c.probedAt, now)}探的` : quiet ? undefined : '探针还没看过',
  ].filter((x): x is string => x !== undefined);
  return (
    <li
      data-channel={c.channel.id}
      data-state={c.interrupted ? 'interrupted' : c.state}
      data-kind={c.kind}
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
        aria-label={`${c.channel.name}：${c.interrupted ? '检测中断' : c.label}，${summary.join('，')}`}
        className="flex min-h-12 w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span
          title={c.rank ? `顺位第 ${c.rank}` : '没排进顺位'}
          className="num grid size-5 shrink-0 place-items-center rounded-full bg-foreground/10 text-caption font-medium"
        >
          {c.rank ?? '–'}
          <span className="sr-only">{c.rank ? `顺位第 ${c.rank}` : '没排进顺位'}</span>
        </span>
        <StatusDot tone={c.tone} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-sm font-semibold', quiet && 'text-muted-foreground')}>
              {c.channel.name}
            </span>
            <StatusChip tone={c.tone} label={c.label} className={cn(c.interrupted && 'font-semibold')} />
            {probing ? (
              <span className="inline-flex items-center gap-1 text-caption text-ink-run">
                <LoaderCircle className="size-3 animate-spin" aria-hidden />
                探测中
              </span>
            ) : null}
          </span>
          <span className="num mt-0.5 block truncate text-caption text-muted-foreground">
            {summary.join(' · ')}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </li>
  );
}

/** 不够 60 格时左边的空位。键按「第几格」写死，不拿数组下标当键。 */
function emptySlotKeys(channelId: string, count: number): string[] {
  const keys: string[] = [];
  for (let n = 1; n <= count; n++) keys.push(`${channelId}:empty:${n}`);
  return keys;
}

/** 详情里的探针历史：均耗时、可用率，加近 60 次格子。读不到不画格子。 */
export function HistoryStrip({
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
      <p data-history="loading" className="mb-3 text-caption text-muted-foreground">
        正在读探针历史
      </p>
    );
  }
  if (history.state === 'unreadable') {
    return (
      <p role="alert" data-history="unreadable" className="mb-3 text-caption text-ink-fail">
        {history.why}
      </p>
    );
  }
  const strip = history.channels.find((item) => item.channelId === channelId);
  const cells = (strip?.cells ?? []).slice(-PROBE_HISTORY_SLOTS);
  const empties = emptySlotKeys(channelId, PROBE_HISTORY_SLOTS - cells.length);
  return (
    <div data-history="strip" data-channel-history={channelId} className="mb-3">
      <p data-history-stats className="num text-caption text-muted-foreground">
        近 60 次 · 均耗时 {formatProbeMs(strip?.avgDurationMs ?? null)} · 可用率{' '}
        {formatAvailability(strip?.passed ?? 0, strip?.attempted ?? 0)}
      </p>
      <div className="mt-1.5 flex h-5 gap-px">
        {empties.map((slot) => (
          <span
            key={slot}
            data-result="empty"
            className="h-full min-w-0 flex-1 rounded-2 border border-dashed border-foreground/15"
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
                'h-full min-w-0 flex-1 rounded-2',
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
