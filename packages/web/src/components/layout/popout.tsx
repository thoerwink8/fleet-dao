// 弹出到新窗口的页（#3533，样稿 canvas/TaskRun.dc.html）：不带侧栏顶栏，自己一条细顶栏（回到哪、这张单是什么），
// 下面左边一张窄卡列这张单的笔（side），右边一张宽卡放那一笔（标题、一行概况、children 自己撑满并滚）。
// 窄屏（md 以下）左卡收起，右卡铺满，回到任务页的链接本来就在顶栏最左（和旧页一致）。没有 side 时只画一张居中的窄卡（出错、没有这张单）。
// 要放在 routes/bare.tsx 的整屏竖排框里（flex-1 撑满）。不收 className 和 style。
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/utils';

export function Popout({
  backHref,
  backLabel = '回到任务页',
  taskLabel,
  sideTitle,
  sideCount,
  side,
  title,
  meta,
  notice,
  embedded,
  children,
}: {
  /** 陈列页里用：固定高度、圆角，不撑满整屏。 */
  embedded?: boolean;
  backHref: string;
  backLabel?: string;
  /** 顶栏上回链后面这张单是什么（「#3491 标题」）。 */
  taskLabel?: ReactNode;
  /** 左卡的标题和笔数。 */
  sideTitle?: string;
  sideCount?: ReactNode;
  /** 左卡的内容（一般是分好组的 PickList）；不给就没有左卡。 */
  side?: ReactNode;
  /** 右卡的标题（h1）和标题下一行小字。 */
  title?: ReactNode;
  meta?: ReactNode;
  /** 右卡标题下面的提示条（刷新没成、下面是旧的）。 */
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-popout
      className={cn(
        'flex min-h-0 flex-col bg-page',
        embedded ? 'h-120 overflow-hidden rounded-md border border-line' : 'flex-1',
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-card px-4">
        <Link
          to={backHref}
          data-popout-back
          className="inline-flex shrink-0 items-center gap-1 rounded-sm text-body text-brand-ink hover:text-link-hover focus-visible:ring-2 focus-visible:ring-brand-hover focus-visible:outline-none max-md:min-h-10"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {backLabel}
        </Link>
        {taskLabel ? (
          <>
            <span aria-hidden className="h-4 w-px shrink-0 bg-line-2" />
            <span className="min-w-0 truncate text-body text-ink">{taskLabel}</span>
          </>
        ) : null}
      </header>
      {side !== undefined ? (
        <div className="flex min-h-0 flex-1 gap-4 p-4 max-md:p-0">
          <aside
            aria-label={sideTitle}
            className="hidden w-90 shrink-0 flex-col overflow-hidden rounded-md bg-card md:flex"
          >
            <h2 className="flex shrink-0 items-center gap-2 px-section pt-4 pb-3 text-heading text-ink">
              {sideTitle}
              {sideCount !== undefined ? (
                <span className="num inline-block h-4.5 min-w-5 rounded-full bg-fill-2 px-1.5 text-center text-meta font-normal text-ink-2">
                  {sideCount}
                </span>
              ) : null}
            </h2>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{side}</div>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md bg-card max-md:rounded-none">
            {title ? (
              <div className="shrink-0 px-4 pt-4 pb-3">
                <h1 data-popout-title className="text-title text-ink">
                  {title}
                </h1>
                {meta ? <div className="mt-1">{meta}</div> : null}
              </div>
            ) : null}
            {notice ? <div className="shrink-0 px-4 pb-3">{notice}</div> : null}
            {children}
          </main>
        </div>
      ) : (
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6 max-md:p-4">
          <div className="mx-auto flex w-full max-w-160 flex-col gap-4">{children}</div>
        </main>
      )}
    </div>
  );
}
