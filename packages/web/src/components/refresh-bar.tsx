// 数据页共用的一条：刷新、最后更新、过期。dataUpdatedAt 用毫秒时间戳，0 表示从没读成过（不能拿它去算「刚刚」）。
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';
import { Button } from './ui/button';

export function RefreshBar({
  onRefresh,
  isFetching,
  dataUpdatedAt,
  staleAfterMs,
  className,
}: {
  onRefresh: () => void;
  isFetching: boolean;
  dataUpdatedAt: number;
  staleAfterMs: number;
  className?: string;
}) {
  const now = useNow();
  const never = dataUpdatedAt === 0;
  // 页内时钟一秒才跳一次。读完那一下 dataUpdatedAt 可能比时钟新，按「未来」会写成「秒后」。
  const shownAt = dataUpdatedAt > now ? now : dataUpdatedAt;
  const stale = !never && now - dataUpdatedAt > staleAfterMs;
  // 手机上刷新收成一个图标按钮（名字留给读屏），「最后更新」写在它左边：整条一行，不再独占一整行（#1820）
  const phone = usePhone();
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
