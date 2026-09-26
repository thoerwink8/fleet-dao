// 「待实现」占位：一块功能还没做（后端装配时给的 NotWired，和 /healthz 的「未接」同一个做法），整块换成它，
// 写明排在哪个阶段、哪张单。不许用「没查成」「离线」说还没做的东西——那两个词只留给真去读了、读失败的。

import type { NotWired } from '@fleet-dao/shared';
import { cn } from '../lib/utils';
import { RepoLink } from './repo-link';

export function NotBuilt({
  notWired,
  compact,
  className,
}: {
  notWired: NotWired;
  compact?: boolean;
  className?: string;
}) {
  const label = `#${notWired.issue}`;
  return (
    <div
      role="note"
      data-not-built={notWired.issue}
      className={cn(
        'flex items-center gap-4 rounded-xl border border-dashed bg-card text-muted-foreground',
        compact ? 'px-4 py-3' : 'flex-col px-6 py-10 text-center',
        className,
      )}
    >
      <Blueprint className={compact ? 'size-10 shrink-0' : 'size-24'} />
      <div className={cn('min-w-0', compact ? 'text-sm' : 'text-[15px]')}>
        <div className="font-medium text-foreground">{notWired.what} · 待实现</div>
        <div className="mt-0.5">
          这块还没做，排在 {notWired.phase} ·{' '}
          {notWired.issueRepo ? (
            <RepoLink repo={notWired.issueRepo} kind="issues" n={notWired.issue} className="num underline">
              {label}
            </RepoLink>
          ) : (
            <span className="num">{label}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 一张图纸加一把尺：还在画、没盖起来。只用 currentColor，跟着主题走。 */
function Blueprint({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={className}
    >
      <rect x="14" y="18" width="60" height="52" rx="4" strokeDasharray="5 4" />
      <path d="M26 58 L26 38 L44 28 L62 38 L62 58 Z" strokeLinejoin="round" />
      <path d="M38 58 V46 H50 V58" strokeLinejoin="round" />
      <path d="M58 74 L84 48 L90 54 L64 80 Z" strokeLinejoin="round" />
      <path d="M66 70 l3 3 M71 65 l3 3 M76 60 l3 3 M81 55 l3 3" />
    </svg>
  );
}
