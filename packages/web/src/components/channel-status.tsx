// 渠道状态（#1087，路由页顶部）：照 mirastatus 的样子，每个渠道一张卡，一眼看通不通。
// 改这里之前必须知道：
// - 绿灯只表示本节点最近一轮抽测通过；上次探超过「探测间隔 + 3 分钟」就改成「检测中断」，不拿旧绿灯装没事。
// - 排序、顺延、状态怎么并都在 lib/channel-status.ts；这里只画，不再判。
// - 探针报错 = 这个渠道暂不可用（禁用）、选路顺延到下一个：只显示，选路另有判法，别在这里改。
// - 渠道名用目录里公开的名字；渠道下的上游模型串不露。

import { useRouting } from '../api/client';
import type { RoutingLayers } from '../api/types';
import { buildChannelCards, type ChannelCard } from '../lib/channel-status';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';
import { LoadError, LoadingRows, Panel } from './page';
import { StatusChip, StatusDot } from './status';
import { Badge } from './ui/badge';

const DESCRIPTION = '渠道状态，一眼就知道。按顺位排：探针报错的渠道暂不可用，选路顺延到下一个。';

export function ChannelStatus({ layers }: { layers: RoutingLayers }) {
  const { data, error, isLoading } = useRouting();
  const now = useNow();

  if (error || isLoading || !data) {
    return (
      <Panel title="渠道状态" description={DESCRIPTION} className="mb-4">
        {error ? <LoadError what="渠道状态" error={error} /> : <LoadingRows rows={3} />}
      </Panel>
    );
  }

  const cards = buildChannelCards(data, layers, now);
  return (
    <Panel title="渠道状态" description={DESCRIPTION} className="mb-4">
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">目录里一个渠道都没有：去看后端日志。</p>
      ) : (
        <ol aria-label="渠道状态" className="space-y-2">
          {cards.map((c) => (
            <ChannelRow key={c.channel.id} card={c} now={now} />
          ))}
        </ol>
      )}
      <ul className="mt-4 space-y-1 border-t pt-3 text-caption text-muted-foreground">
        <li>绿灯只表示本节点最近一轮抽测通过，不保证每次使用都正常。</li>
        <li>
          上次探测超过「探测间隔 + 3
          分钟」还没更新，就显示「检测中断」，不拿旧绿灯掩盖中断；没在配的路由里的渠道不花额度去探。
        </li>
        <li>页面每 30 秒自动刷新。这是对创始人和团队的看家数据。</li>
      </ul>
    </Panel>
  );
}

function ChannelRow({ card: c, now }: { card: ChannelCard; now: number }) {
  const down = c.state === 'down' && !c.interrupted;
  const quiet = c.state === 'idle' || c.state === 'off';
  const dot: Tone = quiet ? 'stop' : c.tone;
  const meta = [
    c.probedAt ? `${formatAgo(c.probedAt, now)}探的` : quiet ? undefined : '探针还没看过',
    c.latency,
    c.deadRoutes > 0 && c.activeRoutes > 1 ? `${c.deadRoutes}/${c.activeRoutes} 条路不通` : undefined,
  ].filter((x): x is string => x !== undefined);
  return (
    <li
      data-channel={c.channel.id}
      data-state={c.interrupted ? 'interrupted' : c.state}
      className={cn(
        'rounded-lg border px-3.5 py-3',
        down && 'border-st-fail/40 bg-st-fail/10',
        c.interrupted && 'border-st-stall/50 bg-st-stall/10',
        quiet && 'bg-muted/30',
      )}
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
        {down ? (
          <Badge variant="outline" className="h-4 px-1 text-micro font-normal text-ink-fail">
            已禁用
          </Badge>
        ) : null}
        {meta.length > 0 ? (
          <span className="num ml-auto text-caption text-muted-foreground">{meta.join(' · ')}</span>
        ) : null}
      </div>
      {c.interrupted ? (
        <p role="status" className="mt-1.5 text-sub font-medium text-ink-stall">
          检测中断：探针超过间隔没更新这个渠道，上次的结论不再当现状
          {c.probedAt ? `（${formatAgo(c.probedAt, now)}）` : null}
        </p>
      ) : null}
      {c.fallback ? <p className="mt-1.5 text-sub text-ink-fail">{c.fallback}</p> : null}
      {c.reason ? (
        <p className="mt-1 break-words text-caption text-muted-foreground" title={c.reason}>
          {c.reason}
        </p>
      ) : null}
    </li>
  );
}
