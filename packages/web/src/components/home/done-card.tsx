// 「做完的」一篇 PR：编号、标题、合进去多久了。链接去 GitHub。

import { GitPullRequestArrow } from 'lucide-react';
import { formatAgo } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import type { HomeDone } from './types';

export function DoneCard({ item, className }: { item: HomeDone; className?: string }) {
  const now = useNow();
  const prLabel = `PR #${item.prNumber}`;
  const body = (
    <>
      <span
        className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-st-done/12 text-ink-done"
        aria-hidden
      >
        <GitPullRequestArrow className="size-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {/* 标题就是「PR #号」（没读到 PR 标题的退路）时只显示一次 */}
          {item.title === prLabel ? null : (
            <span className="num text-xs font-semibold text-muted-foreground">{prLabel}</span>
          )}
          <span className="truncate text-sm font-medium">{item.title}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="num">{item.repo}</span>
          <span aria-hidden>·</span>
          <span className="num">合于 {formatAgo(item.mergedAt, now)}</span>
        </div>
      </div>
    </>
  );
  const cls =
    'flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:border-border-strong';
  return (
    <li data-done-card className={cn('block', className)}>
      {/* 没有链接时纯展示，不可点。 */}
      {item.link ? (
        <a href={item.link} target="_blank" rel="noreferrer" className={cls}>
          {body}
        </a>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}
