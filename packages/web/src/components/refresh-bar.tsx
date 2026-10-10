// 数据页共用的一条：刷新、最后更新、过期。dataUpdatedAt 用毫秒时间戳，0 表示从没读成过（不能拿它去算「刚刚」）。
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Button } from './ui/button';

export function RefreshBar({
  onRefresh,
  isFetching,
  dataUpdatedAt,
  staleAfterMs,
}: {
  onRefresh: () => void;
  isFetching: boolean;
  dataUpdatedAt: number;
  staleAfterMs: number;
}) {
  const now = useNow();
  const never = dataUpdatedAt === 0;
  // 页内时钟一秒才跳一次。读完那一下 dataUpdatedAt 可能比时钟新，按「未来」会写成「秒后」。
  const shownAt = dataUpdatedAt > now ? now : dataUpdatedAt;
  const stale = !never && now - dataUpdatedAt > staleAfterMs;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled={isFetching}
        aria-busy={isFetching}
        className="aria-disabled:cursor-default aria-disabled:opacity-50"
        onClick={() => {
          if (!isFetching) onRefresh();
        }}
      >
        {isFetching ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        刷新
      </Button>
      <span role="status">
        {never ? (
          <span className="text-caption text-muted-foreground">还没读到过</span>
        ) : (
          <span className="text-caption text-muted-foreground">
            最后更新 <span className="num">{formatAgo(new Date(shownAt).toISOString(), now)}</span>
          </span>
        )}
      </span>
      {stale ? (
        <span className="inline-flex h-5 items-center rounded-full bg-st-stall/14 px-1.5 text-caption font-medium text-ink-stall">
          数据已过期
        </span>
      ) : null}
    </div>
  );
}
