// 可展开的列表行（#1805）：一行摘要（名字、状态点、关键数字、相对时间），点一下才展开明细。
// 默认收起；整行是一个按钮（aria-expanded），键盘 Enter / 空格同样展开。
import { ChevronRight } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { cn } from '../lib/utils';

export function ExpandRow({
  summary,
  children,
  rail,
  className,
  defaultOpen = false,
  ...rest
}: {
  summary: ReactNode;
  children: ReactNode;
  /** 左边竖线的颜色类（出问题的行）；不给就没有。 */
  rail?: string | undefined;
  defaultOpen?: boolean;
} & Omit<ComponentProps<'li'>, 'children'>) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <li className={cn('relative', className)} {...rest}>
      {rail ? <span aria-hidden className={cn('absolute inset-y-0 left-0 w-rail', rail)} /> : null}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-10 w-full items-center gap-3 px-4 py-2 text-left outline-none focus-visible:ring-focus focus-visible:ring-ring/50 hover:bg-muted/40"
      >
        {summary}
        <ChevronRight
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          aria-hidden
        />
      </button>
      {open ? (
        <div id={bodyId} className="border-t bg-muted/30 px-4 py-3">
          {children}
        </div>
      ) : null}
    </li>
  );
}
