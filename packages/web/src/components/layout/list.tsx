// 列表和列表行（参照 shadcn Item）。合并了原来的 ExpandRow：expandable 的行整行是一个按钮（aria-expanded），点一下才展开明细。
// 行高桌面 40、手机 44；左边的竖线（rail）标出问题行。
import { ChevronRight } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/utils';
import { type LayoutTone, solidClass } from './tone';

export function List({ divided = true, className, ...rest }: { divided?: boolean } & ComponentProps<'ul'>) {
  return <ul className={cn(divided && 'divide-y divide-border', className)} {...rest} />;
}

const rowBase =
  'flex min-h-10 w-full items-center gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-focus focus-visible:ring-ring max-md:min-h-11';
const rowHover = 'hover:bg-accent';

export function ListRow({
  leading,
  title,
  meta,
  trailing,
  summary,
  href,
  onClick,
  selected,
  rail,
  expandable,
  defaultOpen = false,
  details,
  className,
  children,
  ...rest
}: {
  /** 行首：状态点、图标。 */
  leading?: ReactNode;
  /** 主行文字。 */
  title?: ReactNode;
  /** 主行下面的小字（用 MetaLine）。 */
  meta?: ReactNode;
  /** 行尾：状态标签、时间、数字。 */
  trailing?: ReactNode;
  /** 整行自己排：给了就不用 leading、title、meta、trailing（列多的表格式行）。 */
  summary?: ReactNode;
  /** 整行是链接。 */
  href?: string | undefined;
  /** 整行是按钮。 */
  onClick?: (() => void) | undefined;
  selected?: boolean | undefined;
  /** 左边竖线：这一行有问题。 */
  rail?: LayoutTone | undefined;
  /** 点一下展开 details。 */
  expandable?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  details?: ReactNode;
  className?: string | undefined;
  /** 同 details（展开的明细），写在标签里面更顺手时用。 */
  children?: ReactNode;
} & Omit<ComponentProps<'li'>, 'children' | 'title' | 'onClick'>) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const body = summary ?? (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        {title ? <span className="block truncate text-body">{title}</span> : null}
        {meta ? <span className="block">{meta}</span> : null}
      </span>
      {trailing}
    </>
  );
  const rowClass = cn(rowBase, selected && 'bg-selected', (expandable || href || onClick) && rowHover);
  const detail = details ?? children;
  return (
    <li
      data-selected={selected || undefined}
      className={cn('relative', selected && 'shadow-row-selected', className)}
      {...rest}
    >
      {rail ? (
        <span
          aria-hidden
          data-row-rail
          className={cn('absolute inset-y-0 left-0 w-rail', solidClass[rail])}
        />
      ) : null}
      {expandable ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
            className={rowClass}
          >
            {body}
            <ChevronRight
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
                open && 'rotate-90',
              )}
              aria-hidden
            />
          </button>
          {open ? (
            <div id={bodyId} className="border-t bg-muted px-4 py-3">
              {detail}
            </div>
          ) : null}
        </>
      ) : href ? (
        <Link to={href} className={rowClass}>
          {body}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={rowClass}>
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
    </li>
  );
}
