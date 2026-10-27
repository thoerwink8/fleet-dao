// 侧面板（#3533，任务页的「过程」面板）：盖在右边的抽屉（带遮罩，点遮罩、Esc 关），手机从底下整屏盖上来。
// 和 Drawer 的区别：宽度是像素（页面记在本地、拖左边沿调），头是页面自己排的（返回、上一笔下一笔、弹出、关闭），
// 正文不自带内边距和滚动，由页面决定是整块滚（滚动 scroll）还是里面自己管（会话）。
// 不收 className 和 style；data-* 落在抽屉本体。
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet';

type DataAttrs = { [K in `data-${string}`]?: string | number | boolean | undefined };

export function SidePanel({
  open,
  onOpenChange,
  title,
  description,
  phone = false,
  widthPx,
  resizer,
  header,
  subheader,
  view,
  scroll = true,
  historyEntry = false,
  children,
  ...rest
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 读屏用的标题（不画出来，页面在 header 里自己写可见的）。 */
  title: string;
  description?: string;
  /** 手机：从底下整屏盖上来。 */
  phone?: boolean;
  /** 桌面宽度（像素），最宽不超过屏宽的 90%。 */
  widthPx?: number;
  /** 左边沿的拉宽条。 */
  resizer?: ReactNode;
  /** 头一行（面板自己的标题、按钮）。 */
  header: ReactNode;
  /** 头下面的一行小字。 */
  subheader?: ReactNode;
  /** 现在面板里是什么视图，落在 data-panel-view。 */
  view?: string;
  /** 正文整块滚动（过程）；false 是里面自己管滚动（会话）。 */
  scroll?: boolean;
  /** 打开本身是否要压一条历史（地址参数已经压过就别重复）。 */
  historyEntry?: boolean;
  children: ReactNode;
} & DataAttrs) {
  const style = widthPx === undefined ? undefined : ({ '--side-panel-w': `${widthPx}px` } as CSSProperties);
  return (
    <Sheet open={open} historyEntry={historyEntry} onOpenChange={onOpenChange}>
      <SheetContent
        side={phone ? 'bottom' : 'right'}
        showCloseButton={false}
        {...(style ? { style } : {})}
        className={cn(
          'gap-0 p-0',
          phone ? 'h-dvh max-h-dvh w-full' : 'w-[min(var(--side-panel-w,560px),90vw)] sm:max-w-none',
        )}
        {...rest}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">{description ?? title}</SheetDescription>
        {phone ? null : resizer}
        <div className="flex h-full min-h-0 flex-col" {...(view ? { 'data-panel-view': view } : {})}>
          <header className="flex shrink-0 items-center gap-2 border-b border-line py-2 pr-2 pl-4">
            <div className="min-w-0 flex-1">{header}</div>
          </header>
          {subheader ? (
            <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-2">{subheader}</div>
          ) : null}
          <div
            className={cn(
              'min-h-0 flex-1',
              scroll ? 'overflow-y-auto overscroll-contain scrollbar-thin' : 'flex flex-col',
            )}
            data-panel-body
          >
            {children}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** 面板左边沿的拉宽条（window splitter）：可聚焦、可拖、左右键调；值是现在的宽度。 */
export function PanelResizer({
  width,
  label,
  onPointerDown,
  onKeyDown,
}: {
  width: number;
  label: string;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 可聚焦、可拖动的分隔条（window splitter），<hr> 不能带键盘和拖动
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      data-panel-resizer
      className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-line-2 focus-visible:bg-brand-hover focus-visible:outline-none"
    />
  );
}
