// 渠道状态（#1087，重做 #1366）：渠道状态页左栏是一列折叠的摘要行（名字、状态、几条在线/故障/已关、最近探测时间），
// 点一行右边（手机上是整页）看这个渠道的每条路由、原文、立即探测；路由页顶上只放一行 ChannelStrip 指过去。
// 近 60 次格子是探针真历史（#1139）：一次探针一格，绿通过、红不通、黄没探。均耗时和可用率按这 60 格算，格子在详情里。
// 改这里之前必须知道：
// - 绿灯只表示本节点最近一轮抽测通过；上次探超过「探测间隔 + 3 分钟」就改成「检测中断」，不拿旧绿灯装没事。
// - 排序、顺延、运行中失败、状态怎么并都在 lib/channel-status.ts；状态种类（在线、故障、已关、未被用途使用……）在
//   lib/route-state.ts：这里只画，不再判。只有故障画红；已关、未使用、池暂停不是坏了，不画红。
// - 渠道名用目录里公开的名字；渠道下的上游模型串不露。
// - 库读不到写「没查成」，不画空格子冒充没有历史。空格子只在读成了、次数不够 60 时补位。
// - 尺寸 token：故障说明 grid-cols-auto-fr（标签 auto、剩余）；探针格圆角 rounded-sm（原来 2px）。

import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import type { ProbeHistoryCell, ProbeHistoryChannel } from '../api/types';
import { type ChannelCard, quotaCountText } from '../lib/channel-status';
import { formatAgo, formatClock, formatIn } from '../lib/format';
import type { PoolProblem } from '../lib/pool-problems';
import {
  formatAvailability,
  formatProbeMs,
  PROBE_KIND_BG,
  type ProbeKind,
  probeKind,
  probeWord,
} from '../lib/probe-history-view';
import type { Failover } from '../lib/provider-status';
import { countsText, STATE_FILTERS, type StateFilter } from '../lib/route-state';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';
import { FilterTabs } from './layout/filter-tabs';
import { List, ListRow } from './layout/list';
import { SearchInput } from './layout/search-input';
import { StatusBadge } from './layout/status-badge';

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
        'grid grid-cols-auto-fr gap-x-2 gap-y-0.5 text-meta', // 原标签列 auto、剩余 1fr，grid-cols-auto-fr
        compact ? 'mt-2 text-muted-foreground' : 'mb-3 rounded-md border bg-muted px-3 py-2.5 text-body',
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
          : '下一轮探针（这条路由的下次探测时刻库里还没写）'}
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
      <SearchInput
        value={search}
        onChange={onSearch}
        placeholder="搜渠道、模型、路由号"
        aria-label="搜索渠道"
        className="md:max-w-none"
      />
      <FilterTabs
        mode="toggle"
        aria-label="按状态筛选"
        value={filter}
        onChange={onFilter}
        items={STATE_FILTERS.map((f) => ({
          id: f.id,
          label: f.label,
          count: counts[f.id],
          // 有故障的时候「故障」这一档前面亮红点
          ...(f.id === 'fault' && counts.fault > 0 ? { tone: 'fail' as const } : {}),
        }))}
      />
    </div>
  );
}

/** 渠道状态页左栏：一列折叠的摘要行（按给的顺序画），点一行右边看这个渠道的每条路由。 */
export function ChannelList({
  cards,
  selected,
  probing,
  problems,
  now,
  onPick,
}: {
  cards: readonly ChannelCard[];
  selected: string | undefined;
  /** 此刻有路由在立即探测的渠道。 */
  probing: ReadonlySet<string>;
  /** 渠道下有毛病的池（额度读不到、凭据过期），按渠道号；没有的渠道不在里面。 */
  problems: ReadonlyMap<string, readonly PoolProblem[]>;
  now: number;
  onPick: (channelId: string) => void;
}) {
  return (
    <>
      {/* 左边的数字圈是派活的先后：给一行列头说明，不让它没头没尾（#1903） */}
      <div data-rank-header className="border-b px-4 py-1.5 text-meta text-muted-foreground">
        左边的数字是优先级：数字小的先用
      </div>
      <List aria-label="渠道状态">
        {cards.map((c) => (
          <ChannelRow
            key={c.channel.id}
            card={c}
            now={now}
            selected={c.channel.id === selected}
            probing={probing.has(c.channel.id)}
            problems={problems.get(c.channel.id) ?? []}
            onPick={() => onPick(c.channel.id)}
          />
        ))}
      </List>
    </>
  );
}

function ChannelRow({
  card: c,
  now,
  selected,
  probing,
  problems,
  onPick,
}: {
  card: ChannelCard;
  now: number;
  selected: boolean;
  probing: boolean;
  problems: readonly PoolProblem[];
  onPick: () => void;
}) {
  const down = c.state === 'down' && !c.interrupted;
  // 已关、未被用途使用、下架：灰着，不是坏了
  const quiet = c.kind === 'off' || c.kind === 'unused' || c.kind === 'retired';
  const unreadable = problems.some((p) => p.kind === 'unreadable');
  // 访问令牌过期但 CLI 还能续：先等它自己好，别跟「要人重新登录」说成一件事。
  const waitingCli =
    unreadable && problems.every((p) => p.kind !== 'unreadable' || p.code === 'auth_refreshable');
  const quotaLine =
    problems.length === 0
      ? undefined
      : !unreadable
        ? '额度读数过期'
        : waitingCli
          ? '额度读不到，等 grok 下次运行自己续'
          : '额度读不到，要人处理';
  const summary = [
    countsText(c.counts),
    quotaCountText(c),
    c.probedAt ? `${formatAgo(c.probedAt, now)}探的` : quiet ? undefined : '探针还没看过',
    quotaLine,
  ].filter((x): x is string => x !== undefined);
  return (
    <ListRow
      data-channel={c.channel.id}
      data-state={c.interrupted ? 'interrupted' : c.state}
      data-kind={c.kind}
      rail={down || c.interrupted ? 'fail' : undefined}
      selected={selected}
      summary={
        // 整行是一个按钮：ListRow 的 onClick 够不到 aria-current 和 aria-label，所以按钮自己写，用负边距盖满行
        <button
          type="button"
          onClick={onPick}
          aria-current={selected ? 'true' : undefined}
          aria-label={`${c.channel.name}：${c.interrupted ? '检测中断' : c.label}，${summary.join('，')}`}
          className="-mx-4 -my-2.5 flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left outline-none hover:bg-accent focus-visible:ring-focus focus-visible:ring-ring max-md:min-h-11"
        >
          <span
            title={c.rank ? `顺位第 ${c.rank}` : '没排进顺位'}
            className="num grid size-5 shrink-0 place-items-center rounded-full bg-selected text-meta font-medium"
          >
            {c.rank ?? '–'}
            <span className="sr-only">{c.rank ? `顺位第 ${c.rank}` : '没排进顺位'}</span>
          </span>
          {/* 一行一个名字一个状态（点加字，状态点不再单独画一遍）；下面一行小字不折，整句在悬停里（样板 #1914） */}
          <span className="min-w-0 flex-1">
            {/* 名字是认渠道的那一样，不截断：真放不下（320 宽加长状态）宁可状态换到下一行 */}
            <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
              <span className={cn('text-body font-medium break-words', quiet && 'opacity-60')}>
                {c.channel.name}
              </span>
              <StatusBadge
                tone={c.tone}
                label={c.label}
                variant="dot"
                className={cn('shrink-0', c.interrupted && 'font-semibold')}
              />
              {probing ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-meta text-ink-run">
                  <LoaderCircle className="size-3 animate-spin" aria-hidden />
                  探测中
                </span>
              ) : null}
            </span>
            <span
              data-row-meta
              title={summary.join(' · ')}
              className="num mt-0.5 block truncate whitespace-nowrap text-meta text-muted-foreground"
            >
              {summary.join(' · ')}
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      }
    />
  );
}

/** 手机上整条色条的读屏汇总：近几次里通过、不通、疑似换模型各几次；有连通但额度耗尽的才另报几次。 */
function stripSummary(cells: readonly ProbeHistoryCell[]): string {
  const count = (k: ProbeKind) => cells.filter((c) => probeKind(c) === k).length;
  const quota = count('quota');
  return `近 ${cells.length} 次真探：通过 ${count('passed')}${quota > 0 ? `、连通但额度耗尽 ${quota}` : ''}、不通 ${count('failed')}、疑似换模型 ${count('doubt')}`;
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
  const phone = usePhone();
  if (history.state === 'loading') {
    return (
      <p data-history="loading" className="mb-3 text-meta text-muted-foreground">
        正在读探针历史
      </p>
    );
  }
  if (history.state === 'unreadable') {
    return (
      <p role="alert" data-history="unreadable" className="mb-3 text-meta text-ink-fail">
        {history.why}
      </p>
    );
  }
  const strip = history.channels.find((item) => item.channelId === channelId);
  // 色条只画真探的（#1748）：没探的不占格子、不进可用率，在下面「探测记录」里折着
  const cells = (strip?.cells ?? []).filter((c) => c.result !== 'not_probed').slice(-PROBE_HISTORY_SLOTS);
  const skippedCount = (strip?.skipped ?? []).length;
  const empties = emptySlotKeys(channelId, PROBE_HISTORY_SLOTS - cells.length);
  return (
    <div data-history="strip" data-channel-history={channelId} className="mb-3">
      <p
        data-history-stats
        title="近 60 次真探的均耗时和可用率；没真探的不进可用率，在下面的探测记录里折着"
        className="num truncate whitespace-nowrap text-meta text-muted-foreground"
      >
        近 60 次真探 · 均耗时 {formatProbeMs(strip?.avgDurationMs ?? null)} · 可用率{' '}
        {formatAvailability(strip?.passed ?? 0, strip?.attempted ?? 0)}
        {skippedCount > 0 ? ` · 另有 ${skippedCount} 条没真探，折在下面` : ''}
      </p>
      <div
        className="mt-1.5 flex h-5 gap-px"
        {...(phone ? { role: 'img', 'aria-label': stripSummary(cells), 'data-strip-display': 'true' } : {})}
      >
        {empties.map((slot) => (
          <span
            key={slot}
            data-result="empty"
            className="h-full min-w-0 flex-1 rounded-sm border border-dashed border-border-strong" // 原圆角 2px，rounded-sm
          />
        ))}
        {cells.map((cell) => {
          const kind = probeKind(cell);
          const word = probeWord(cell);
          const on = cell.id === activeCellId;
          // 手机上 60 格只做展示：每格 3px 宽点不准，定位靠下面的探测记录行
          if (phone) {
            return (
              <span
                key={cell.id}
                aria-hidden
                data-result={kind}
                data-cell={cell.id}
                className={cn(
                  'h-full min-w-0 flex-1 rounded-sm',
                  PROBE_KIND_BG[kind],
                  on && 'ring-2 ring-foreground',
                )}
              />
            );
          }
          return (
            <button
              key={cell.id}
              type="button"
              data-result={kind}
              data-cell={cell.id}
              aria-pressed={on}
              title={`${formatClock(cell.probedAt)} ${cell.routeId} ${word} ${formatProbeMs(cell.durationMs, cell.result)}`}
              onClick={() => onPickCell(channelId, cell.id)}
              className={cn(
                'h-full min-w-0 flex-1 rounded-sm', // 原圆角 2px，rounded-sm
                PROBE_KIND_BG[kind],
                on && 'ring-2 ring-foreground',
              )}
            >
              <span className="sr-only">
                {formatClock(cell.probedAt)} {cell.routeId} {word}
              </span>
            </button>
          );
        })}
      </div>
      {/* 颜色的图例在下面探测记录的图例里（同一套颜色，原来这里又写一遍），这里只在一格都没有时说一句 */}
      {cells.length === 0 ? <p className="mt-1 text-meta text-muted-foreground">还没有真探</p> : null}
    </div>
  );
}
