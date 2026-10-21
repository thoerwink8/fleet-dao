// 抽屉（包 ui/sheet，参数名照 antd 的 Drawer）：从右边滑进来，三种宽度；标题一行带关闭，中间滚动，底下可放操作。
// 打开时压一条历史记录，手机后退键只关这一层（ui/sheet 管）。滑入 300、滑出 300，跟着「减少动效」。不收 className 和 style。
import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../ui/sheet';

/** 宽度：sm 360、md 480、lg 640（设计值）；窄屏一律铺满。 */
const WIDTH = {
  sm: 'w-full sm:w-90 sm:max-w-none',
  md: 'w-full sm:w-120 sm:max-w-none',
  lg: 'w-full sm:w-160 sm:max-w-none',
} as const;

export function Drawer({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  width = 'md',
  footer,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 点它打开抽屉（一个按钮元素）。 */
  trigger?: ReactNode;
  title: ReactNode;
  /** 标题下的一句话（也是读屏的描述）。 */
  description?: ReactNode;
  width?: keyof typeof WIDTH;
  /** 底部操作区，靠右排。 */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent
        side="right"
        data-width={width}
        className={`${WIDTH[width]} gap-0 p-0`}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <div className="flex flex-col gap-1 border-b border-line py-4 pr-12 pl-5">
          <SheetTitle className="text-heading">{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
