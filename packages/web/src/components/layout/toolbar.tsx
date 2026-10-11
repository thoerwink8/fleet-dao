// 工具条：筛选在左，搜索和下拉在右；窄屏换行（筛选条自己横滑）。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Toolbar({
  start,
  end,
  sticky,
  className,
}: {
  start?: ReactNode;
  end?: ReactNode;
  /** 滚动时钉在顶栏下面。 */
  sticky?: boolean;
  className?: string;
}) {
  return (
    <div
      role="toolbar"
      data-sticky={sticky || undefined}
      className={cn(
        'mb-4 flex flex-wrap items-center justify-between gap-2',
        sticky && 'sticky top-topbar z-10 -mx-1 bg-background px-1 py-2',
        className,
      )}
    >
      {start ? <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{start}</div> : null}
      {end ? <div className="flex min-w-0 flex-wrap items-center gap-2 max-md:w-full">{end}</div> : null}
    </div>
  );
}
