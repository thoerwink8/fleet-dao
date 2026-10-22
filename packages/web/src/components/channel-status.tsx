// 渠道状态（#1087，重做 #1366，照 Arco 迁 #3533）：渠道状态页左栏是一列摘要行（名字、状态、几条在线/故障/已关、最近探测时间），
// 点一行右边（窄屏是抽屉）看这个渠道的每条路由、原文、立即探测；路由页顶上只放一行 ChannelStrip 指过去。
// 近 60 次格子是探针真历史（#1139）：一次探针一格，灰通过、红不通、橙疑似换模型或额度耗尽（ProbeCells，颜色只有四档，
// 细分类在 data-kind 和悬停里）。均耗时和可用率按这 60 格算，格子在详情里。
// 改这里之前必须知道：
// - 绿灯只表示本节点最近一轮抽测通过；上次探超过「探测间隔 + 3 分钟」就改成「检测中断」，不拿旧绿灯装没事。
// - 排序、顺延、运行中失败、状态怎么并都在 lib/channel-status.ts；状态种类（在线、故障、已关、未被用途使用……）在
//   lib/route-state.ts：这里只画，不再判。状态词全走字典（channelStatusKey），只有故障、检测中断画红；
//   已关、未使用、池暂停不是坏了，不画红。出问题的行不画红边线、红框，只留状态标签。
// - 渠道名用目录里公开的名字；渠道下的上游模型串不露。
// - 库读不到写「没查成」，不画空格子冒充没有历史。空格子只在读成了、次数不够 60 时补位。

import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import type { ProbeHistoryCell, ProbeHistoryChannel } from '../api/types';
import { type ChannelCard, quotaCountText } from '../lib/channel-status';
import { formatAgo, formatClock, formatIn } from '../lib/format';
import type { PoolProblem } from '../lib/pool-problems';
import {
  formatAvailability,
  formatProbeMs,
  type ProbeKind,
  probeKind,
  probeWord,
} from '../lib/probe-history-view';
import type { Failover } from '../lib/provider-status';
import { countsText, type RouteStateKind, STATE_FILTERS, type StateFilter } from '../lib/route-state';
import { usePhone } from '../lib/viewport';
import type { StatusKey } from '../theme/status-dict';
import { Descriptions } from './layout/descriptions';
import { FilterTabs } from './layout/filter-tabs';
import { List, ListRow } from './layout/list';
import { Notice } from './layout/notice';
import { type ProbeCell, ProbeCells, type ProbeResult } from './layout/probe-cells';
import { SearchInput } from './layout/search-input';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Text } from './layout/text';

/** 渠道卡上的探针历史：读不到和还没有是两回事。 */
export type ChannelHistory =
  | { state: 'loading' }
  | { state: 'unreadable'; why: string }
  | { state: 'ok'; channels: readonly ProbeHistoryChannel[]; latestByRoute: readonly ProbeHistoryCell[] };

/** 路由（或渠道整体）的种类对应的字典键。 */
export function kindStatus(kind: RouteStateKind): StatusKey {
  return `route:${kind}`;
}

/**
 * 渠道摘要行、详情头部那一个状态词的字典键：运行中失败、检测中断先说；然后部分路故障、连通但额度耗尽；
 * 按量计费不自动探；其余按渠道整体是哪一种（在线、故障、已关、未被用途使用、没探……）。
 */
export function channelStatusKey(c: ChannelCard): StatusKey {
  if (c.failover) return 'route:channel:failover';
  if (c.interrupted) return 'route:interrupted';
  if (c.state === 'partial') return 'route:channel:partial';
  if (c.state === 'ok' && c.quota) {
    return c.quota.routes === c.activeRoutes ? 'route:channel:quota-all' : 'route:channel:quota-part';
  }
  if (c.state === 'unknown' && c.channel.billing === 'metered') return 'route:channel:metered';
  return kindStatus(c.kind);
}

/** 探测记录一次的结论对应的字典键。 */
export function probeKindStatus(kind: ProbeKind): StatusKey {
  return `route:probe:${kind}`;
}

/**
 * 运行中失败的渠道（#1118）：为什么不可用、顺延到谁、下次探测。
 * 「顺延到谁」没有的两种情况分开写：还没派出去（没有新的活触发选路）、没有别的渠道可派。
 */
export function FailoverNote({ failover, now }: { failover: Failover; now: number }) {
  const next = failover.nextProbeAt;
  return (
    <div data-failover>
      <Stack gap="md">
        <Notice tone="fail" role="status" title="为什么不可用">
          <span data-field="reason">
            {failover.reason}
            {failover.flaggedAt ? `（${formatClock(failover.flaggedAt)} 标上的）` : null}
          </span>
        </Notice>
        <Descriptions
          columns={2}
          items={[
            {
              label: '顺延到谁',
              value: (
                <span data-field="fallback">
                  {failover.fallback
                    ? `${failover.fallback.channelName} · ${failover.fallback.modelName}`
                    : '还没派出去：没有别的渠道可顺延，或还没有新的活来选路'}
                </span>
              ),
            },
            {
              label: '下次探测',
              value: (
                <span data-field="next-probe" className="num">
                  {next
                    ? `${formatClock(next)}（${formatIn(next, now)}）`
                    : '下一轮探针（这条路由的下次探测时刻库里还没写）'}
                  {failover.failedRouteId
                    ? ` · 探通 ${failover.failedRouteId} 才恢复`
                    : ' · 探通渠道下任一条路由就恢复'}
                </span>
              ),
            },
          ]}
        />
      </Stack>
    </div>
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
    <Stack gap="md">
      <SearchInput
        value={search}
        onChange={onSearch}
        placeholder="搜渠道、模型、路由号"
        aria-label="搜索渠道"
      />
      <FilterTabs
        mode="toggle"
        variant="segmented"
        wrap
        aria-label="按状态筛选"
        value={filter}
        onChange={onFilter}
        items={STATE_FILTERS.map((f) => ({
          id: f.id,
          label: f.label,
          count: counts[f.id],
        }))}
      />
    </Stack>
  );
}

/** 渠道状态页左栏：一列摘要行（按给的顺序画），点一行右边看这个渠道的每条路由。 */
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
    <List aria-label="渠道状态">
      {cards.map((c) => (
        <ChannelRow
          key={c.channel.id}
          card={c}
          now={now}
          selected={c.channel.id === selected}
          probing={probing.has(c.channel.id)}
          problems={problems.get(c.channel.id)}
          onPick={() => onPick(c.channel.id)}
        />
      ))}
    </List>
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
  problems: readonly PoolProblem[] | undefined;
  onPick: () => void;
}) {
  // 已关、未被用途使用、下架：灰着，不是坏了
  const quiet = c.kind === 'off' || c.kind === 'unused' || c.kind === 'retired';
  const list = problems ?? [];
  const unreadable = list.some((p) => p.kind === 'unreadable');
  // 访问令牌过期但 CLI 还能续：先等它自己好，别跟「要人重新登录」说成一件事。
  const waitingCli =
    unreadable && list.every((p) => p.kind !== 'unreadable' || p.code === 'auth_refreshable');
  const quotaLine =
    list.length === 0
      ? undefined
      : !unreadable
        ? '额度读数过期'
        : waitingCli
          ? '额度读不到，等 grok 下次运行自己续'
          : '额度读不到，要人处理';
  const summary = [
    c.rank ? `顺位第 ${c.rank}` : undefined,
    countsText(c.counts),
    quotaCountText(c),
    c.probedAt ? `${formatAgo(c.probedAt, now)}探的` : quiet ? undefined : '探针还没看过',
    quotaLine,
  ].filter((x): x is string => x !== undefined && x !== '');
  const status = channelStatusKey(c);
  return (
    <ListRow
      data-channel={c.channel.id}
      data-state={c.interrupted ? 'interrupted' : c.state}
      data-kind={c.kind}
      tall
      selected={selected}
      onClick={onPick}
      rowLabel={`${c.channel.name}：${statusWord(c)}，${summary.join('，')}`}
      title={
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <Text strong tone={quiet ? 'muted' : 'default'}>
            {c.channel.name}
          </Text>
          <StatusBadge status={status} />
          {probing ? <StatusBadge status="route:probe:running" /> : null}
        </Stack>
      }
      meta={
        <Text size="meta" tone="muted" truncate title={summary.join(' · ')}>
          {summary.join(' · ')}
        </Text>
      }
    />
  );
}

/** 读屏念的状态词（和字典里的中文一致）。 */
function statusWord(c: ChannelCard): string {
  return c.interrupted && !c.failover ? '检测中断' : c.label;
}

/** 手机上整条色条的读屏汇总：近几次里通过、不通、疑似换模型各几次；有连通但额度耗尽的才另报几次。 */
function stripSummary(cells: readonly ProbeHistoryCell[]): string {
  const count = (k: ProbeKind) => cells.filter((c) => probeKind(c) === k).length;
  const quota = count('quota');
  return `近 ${cells.length} 次真探：通过 ${count('passed')}${quota > 0 ? `、连通但额度耗尽 ${quota}` : ''}、不通 ${count('failed')}、疑似换模型 ${count('doubt')}`;
}

/** 一次探测落在格子的哪一档颜色：通过灰，不通红，疑似换模型、额度耗尽橙，没探空心。 */
export function probeResult(kind: ProbeKind): ProbeResult {
  if (kind === 'passed') return 'ok';
  if (kind === 'failed') return 'fail';
  if (kind === 'not_probed') return 'none';
  return 'warn';
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
      <div data-history="loading">
        <Text size="meta" tone="muted">
          正在读探针历史
        </Text>
      </div>
    );
  }
  if (history.state === 'unreadable') {
    return (
      <div data-history="unreadable">
        <Notice tone="fail">{history.why}</Notice>
      </div>
    );
  }
  const strip = history.channels.find((item) => item.channelId === channelId);
  // 色条只画真探的（#1748）：没探的不占格子、不进可用率，在下面「探测记录」里折着
  const cells = (strip?.cells ?? []).filter((c) => c.result !== 'not_probed').slice(-PROBE_HISTORY_SLOTS);
  const skippedCount = (strip?.skipped ?? []).length;
  const pads: ProbeCell[] = Array.from({ length: PROBE_HISTORY_SLOTS - cells.length }, () => ({
    result: 'none' as const,
    label: '',
  }));
  const real: ProbeCell[] = cells.map((cell) => {
    const kind = probeKind(cell);
    return {
      result: probeResult(kind),
      kind,
      id: cell.id,
      label: `${formatClock(cell.probedAt)} ${cell.routeId} ${probeWord(cell)} ${formatProbeMs(cell.durationMs, cell.result)}`,
    };
  });
  const activeIndex = cells.findIndex((c) => c.id === activeCellId);
  return (
    <div data-history="strip" data-channel-history={channelId}>
      <Stack gap="sm">
        <div
          data-history-stats
          title="近 60 次真探的均耗时和可用率；没真探的不进可用率，在下面的探测记录里折着"
        >
          <Text size="meta" tone="muted" truncate>
            近 60 次真探 · 均耗时 {formatProbeMs(strip?.avgDurationMs ?? null)} · 可用率{' '}
            {formatAvailability(strip?.passed ?? 0, strip?.attempted ?? 0)}
            {skippedCount > 0 ? ` · 另有 ${skippedCount} 条没真探，折在下面` : ''}
          </Text>
        </div>
        {phone ? (
          // 手机上 60 格只做展示：每格 3px 宽点不准，定位靠下面的探测记录行
          <ProbeCells items={[...pads, ...real]} summary={stripSummary(cells)} />
        ) : (
          <ProbeCells
            items={[...pads, ...real]}
            selected={activeIndex >= 0 ? pads.length + activeIndex : null}
            onSelect={(i) => {
              const cell = cells[i - pads.length];
              if (cell) onPickCell(channelId, cell.id);
            }}
          />
        )}
        {/* 颜色的图例在下面探测记录的图例里（同一套颜色），这里只在一格都没有时说一句 */}
        {cells.length === 0 ? (
          <Text size="meta" tone="muted">
            还没有真探
          </Text>
        ) : null}
      </Stack>
    </div>
  );
}
