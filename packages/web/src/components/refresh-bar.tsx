// 数据页共用的一条：刷新、最后更新、过期。dataUpdatedAt 用毫秒时间戳，0 表示从没读成过（不能拿它去算「刚刚」）。
// 两种写法：默认 text 是「刷新」按钮加一行「最后更新 …」字；dot（主页用，#1819）是一个新鲜度点加图标刷新按钮，
// 新鲜度看数据年龄和推送：1 分钟内新鲜（不画，只留给读屏）、5 分钟内「数据有点旧」黄、更久或推送断开「数据已过期」红；悬停写具体时间。

import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { ComponentProps } from 'react';
import type { LiveStatus } from '../api/client';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';
import { StatusBadge } from './layout/status-badge';
import type { LayoutTone } from './layout/tone';
import { Button } from './ui/button';

const MIN = 60_000;
/** 新鲜度点：这个年龄以内绿，再到下一个以内黄，更久红。 */
export const FRESH_GREEN_MS = MIN;
export const FRESH_YELLOW_MS = 5 * MIN;

export type Freshness = 'fresh' | 'aging' | 'stale';

/** 按数据年龄和推送状态判新鲜度。推送断开直接算红（数据只靠兜底轮询在更新）。 */
export function freshnessOf(ageMs: number, push?: LiveStatus): Freshness {
  if (push === 'down') return 'stale';
  if (ageMs <= FRESH_GREEN_MS) return 'fresh';
  if (ageMs <= FRESH_YELLOW_MS) return 'aging';
  return 'stale';
}

const freshTone: Record<Freshness, LayoutTone> = {
  fresh: 'done',
  aging: 'wait',
  stale: 'fail',
};

const freshWords: Record<Freshness, string> = {
  fresh: '数据是新的',
  aging: '数据有点旧',
  stale: '数据已过期',
};

export type RefreshBarProps = ComponentProps<typeof RefreshBar>;

export function RefreshBar({
  onRefresh,
  isFetching,
  dataUpdatedAt,
  staleAfterMs,
  className,
  variant = 'text',
  push,
}: {
  onRefresh: () => void;
  isFetching: boolean;
  dataUpdatedAt: number;
  staleAfterMs: number;
  className?: string;
  variant?: 'text' | 'dot';
  /** 推送连接状态（dot 用）：断开（down）时点直接变红。 */
  push?: LiveStatus;
}) {
  const now = useNow();
  const never = dataUpdatedAt === 0;
  // 页内时钟一秒才跳一次。读完那一下 dataUpdatedAt 可能比时钟新，按「未来」会写成「秒后」。
  const shownAt = dataUpdatedAt > now ? now : dataUpdatedAt;
  const stale = !never && now - dataUpdatedAt > staleAfterMs;
  // 手机上刷新收成一个图标按钮（名字留给读屏），「最后更新」写在它左边：整条一行，不再独占一整行（#1820）
  const phone = usePhone();

  if (variant === 'dot') {
    const level: Freshness = never ? 'stale' : freshnessOf(Math.max(0, now - dataUpdatedAt), push);
    const when = never
      ? '还没读到过'
      : `最后更新 ${new Date(shownAt).toLocaleTimeString('zh-CN', { hour12: false })}（${formatAgo(new Date(shownAt).toISOString(), now)}）`;
    const label =
      push === 'down' ? `${freshWords[level]}：推送断开，${when}` : `${freshWords[level]}：${when}`;
    return (
      <div className={cn('flex items-center gap-1', className)} data-refresh-bar="dot">
        {/* 新鲜的时候不占版面（只留给读屏）：以前这里是个没有字的绿点，和「实时」旁边的点重复。旧了才写字、带色。 */}
        <span
          role="status"
          title={label}
          aria-label={label}
          data-freshness={level}
          data-tone={freshTone[level]}
          className={level === 'fresh' ? 'sr-only' : 'inline-flex shrink-0'}
        >
          {level === 'fresh' ? null : (
            <StatusBadge tone={freshTone[level]} variant="outline" label={freshWords[level]} />
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="刷新"
          title="刷新"
          aria-disabled={isFetching}
          aria-busy={isFetching}
          className="size-8 aria-disabled:cursor-default aria-disabled:opacity-50 max-md:size-10"
          onClick={() => {
            if (!isFetching) onRefresh();
          }}
        >
          {isFetching ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', phone && 'flex-row-reverse', className)}>
      <Button
        type="button"
        variant="outline"
        size={phone ? 'icon-lg' : 'sm'}
        aria-label={phone ? '刷新' : undefined}
        aria-disabled={isFetching}
        aria-busy={isFetching}
        data-refresh-icon={phone || undefined}
        className="aria-disabled:cursor-default aria-disabled:opacity-50"
        onClick={() => {
          if (!isFetching) onRefresh();
        }}
      >
        {isFetching ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        {phone ? null : '刷新'}
      </Button>
      <span role="status">
        {never ? (
          <span className="text-meta text-muted-foreground">还没读到过</span>
        ) : (
          <span className="text-meta text-muted-foreground">
            最后更新 <span className="num">{formatAgo(new Date(shownAt).toISOString(), now)}</span>
          </span>
        )}
      </span>
      {stale ? (
        <span className="inline-flex h-5 items-center rounded-full bg-st-stall-soft px-1.5 text-meta font-medium text-ink-stall">
          数据已过期
        </span>
      ) : null}
    </div>
  );
}
