// 工具条（= Arco 的筛选行，#3509，样稿 canvas/fd3.css `.filters`）：筛选在左，搜索和下拉在右；项间横 16 竖 12，窄屏换行（筛选条自己横滑）。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Toolbar({
  start,
  end,
  sticky,
  flush,
  className,
}: {
  /** 下面不留 16 的空（工具条自己就是区块里最后一样时）。 */
  flush?: boolean;
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
        !flush && 'mb-4',
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-3',
        sticky && 'sticky top-topbar z-10 -mx-1 bg-page px-1 py-2',
        className,
      )}
    >
      {start ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-4 gap-y-3">{start}</div>
      ) : null}
      {end ? <div className="flex min-w-0 flex-wrap items-center gap-2 max-md:w-full">{end}</div> : null}
    </div>
  );
}
