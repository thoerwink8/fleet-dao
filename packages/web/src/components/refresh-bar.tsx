// 数据页共用的一条刷新：全站只有这一种样子（Arco 的做法）——灰色图标按钮（悬停有提示），旁边一句灰字「最后更新 …」。
// dataUpdatedAt 用毫秒时间戳，0 表示从没读成过（不能拿它去算「刚刚」）。
// 新鲜度只在出异常时才出声：数据超过 staleAfterMs 没更新，或推送断开，旁边多一个橙色「数据已过期」标签；
// 正常的时候只有那句灰字。状态节点上留 data-freshness（fresh / aging / stale），悬停写具体时间。
// 页面不自己摆刷新按钮：Page 的 refresh 参数就是这个，各页只给 onRefresh、isFetching、dataUpdatedAt、staleAfterMs。

import { RefreshCw } from 'lucide-react';
import type { LiveStatus } from '../api/client';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Button } from './layout/button';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Text } from './layout/text';

const MIN = 60_000;
/** 新鲜度：这个年龄以内算新，再到下一个以内算有点旧，更久算过期（过期还要同时超过页面自己的 staleAfterMs）。 */
export const FRESH_GREEN_MS = MIN;
export const FRESH_YELLOW_MS = 5 * MIN;

export type Freshness = 'fresh' | 'aging' | 'stale';

/** 按数据年龄和推送状态判新鲜度。推送断开直接算过期（数据只靠兜底轮询在更新）。 */
export function freshnessOf(ageMs: number, push?: LiveStatus): Freshness {
  if (push === 'down') return 'stale';
  if (ageMs <= FRESH_GREEN_MS) return 'fresh';
  if (ageMs <= FRESH_YELLOW_MS) return 'aging';
  return 'stale';
}

export type RefreshBarProps = {
  onRefresh: () => void;
  isFetching: boolean;
  dataUpdatedAt: number;
  staleAfterMs: number;
  /** 推送连接状态：断开（down）时直接标「数据已过期」。 */
  push?: LiveStatus;
};

export function RefreshBar({ onRefresh, isFetching, dataUpdatedAt, staleAfterMs, push }: RefreshBarProps) {
  const now = useNow();
  const never = dataUpdatedAt === 0;
  // 页内时钟一秒才跳一次。读完那一下 dataUpdatedAt 可能比时钟新，按「未来」会写成「秒后」。
  const shownAt = dataUpdatedAt > now ? now : dataUpdatedAt;
  const age = Math.max(0, now - dataUpdatedAt);
  const pushDown = push === 'down';
  const stale = !never && (age > staleAfterMs || pushDown);
  const level: Freshness = never ? 'stale' : stale ? 'stale' : freshnessOf(age);
  const when = never
    ? '还没读到过'
    : `最后更新 ${new Date(shownAt).toLocaleTimeString('zh-CN', { hour12: false })}（${formatAgo(new Date(shownAt).toISOString(), now)}）`;
  const hover = pushDown ? `推送断开，${when}` : when;

  return (
    <Stack direction="horizontal" gap="sm" align="center" wrap data-refresh-bar>
      {stale ? <StatusBadge status="machine:refresh:stale" /> : null}
      <span role="status" data-freshness={level} title={hover}>
        {never ? (
          <Text size="meta" tone="muted">
            还没读到过
          </Text>
        ) : (
          <Text size="meta" tone="muted">
            最后更新 {formatAgo(new Date(shownAt).toISOString(), now)}
          </Text>
        )}
      </span>
      <Button iconOnly size="sm" aria-label="刷新" title="刷新" loading={isFetching} onClick={onRefresh}>
        <RefreshCw aria-hidden />
      </Button>
    </Stack>
  );
}
