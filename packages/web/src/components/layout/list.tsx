// 列表和列表行（参照 shadcn Item）。合并了原来的 ExpandRow：expandable 的行整行是一个按钮（aria-expanded），点一下才展开明细。
// 行高取行高令牌（40；两行的 48），手机 44；左边的竖线（rail）标出问题行。
// #3509 照 Arco（样稿 canvas/fd3.css `.list` `.list-item` `tr.detail`）：行间一道 line，能点的行悬停 fill-1，选中 brand-1，展开的明细 fill-1 底。
// 上下内边距 = (行高 − 一行正文 20px) / 2：单行行正好是行高，两行的行跟着行高一起收。
import { ChevronRight } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/utils';
import { type LayoutTone, solidClass } from './tone';

export function List({ divided = true, className, ...rest }: { divided?: boolean } & ComponentProps<'ul'>) {
  return <ul className={cn(divided && 'divide-y divide-line', className)} {...rest} />;
}

const rowBase =
  'flex w-full items-center gap-stack px-section text-left text-ink outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-hover max-md:min-h-11';
/** 一行的行高：单行取 h-row；两行（名字一行加一行小字）取 row-tall，和 RowFrame tall 一样。 */
const rowHeight = {
  single: 'min-h-row py-[calc((var(--spacing-row)-1.25rem)/2)]',
  tall: 'min-h-row-tall py-1.5',
} as const;
const rowHover = 'cursor-pointer hover:bg-fill-1';

/**
 * 一行的外框，给自己管 li 的列表（拖动排序的先后列表）用：行高、左右内边距、元素间距取同一组令牌，和 ListRow 一样高。
 * 带 group/row：行尾菜单（RowMenu）、拖动柄靠它在悬停这一行时才露出。
 */
export function RowFrame({
  tall = false,
  className,
  ...rest
}: {
  /** 两行的行（名字一行加一行小字）：行高取 row-tall（标准 48、紧凑 40），上下内边距 6。 */
  tall?: boolean;
} & ComponentProps<'div'>) {
  return (
    <div
      data-row-frame
      data-tall={tall || undefined}
      className={cn(
        'group/row relative flex w-full items-center gap-stack px-section max-md:min-h-11',
        tall ? 'min-h-row-tall py-1.5' : 'min-h-row py-[calc((var(--spacing-row)-1.25rem)/2)]',
        className,
      )}
      {...rest}
    />
  );
}

/**
 * 行下面展开的明细、提示（三件事的原因、整池暂停表单、退避提示）：左边和行里的名字对齐
 * （行的左内边距 + 展开箭头、序号的宽，app.css 的 --spacing-row-indent），右边和行的右内边距对齐。
 */
export function RowDetail({
  indent = true,
  className,
  ...rest
}: {
  /** 行首没有展开箭头、序号（名字就在行的左内边距上）时传 false：明细只留行的左右内边距，和名字对齐。 */
  indent?: boolean;
} & ComponentProps<'div'>) {
  return (
    <div
      data-row-detail
      className={cn(
        indent ? 'pr-section pl-[calc(var(--spacing-section)+var(--spacing-row-indent))]' : 'px-section',
        className,
      )}
      {...rest}
    />
  );
}

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
  tall = false,
  className,
  children,
  ...rest
}: {
  /** 两行的行（主行一行加一行小字）：行高取 row-tall（标准 48、紧凑 40），和 RowFrame tall 同高（任务列表，#1919）。 */
  tall?: boolean | undefined;
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
  const rowClass = cn(
    rowBase,
    tall ? rowHeight.tall : rowHeight.single,
    (expandable || href || onClick) && rowHover,
    // 选中照 Arco（fd3 `.pick.on`、`tr.sel`）：只换 brand-1 底，不另画竖线
    selected && 'bg-brand-1 hover:bg-brand-1',
  );
  const detail = details ?? children;
  return (
    <li data-selected={selected || undefined} className={cn('relative', className)} {...rest}>
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
                'size-4 shrink-0 text-ink-3 transition-transform duration-200 ease-arco',
                open && 'rotate-90',
              )}
              aria-hidden
            />
          </button>
          {open ? (
            <div id={bodyId} className="bg-fill-1 px-section py-stack">
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
