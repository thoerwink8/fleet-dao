// 列表里可选的一行（提需求页的需求列表）：头像在左，标题一行（右边是时间），下面一行小字（预览、标签），再下面可带一句橙字说明；
// 选中那行浅蓝底；行尾可放「⋯」菜单（menu）。缩进的 indent 是「接着这条提」挂在原条下面。
// checked 不是 undefined 时左边画勾选框（多选）；compact 是收起后的窄条：只剩头像和状态点。
// 手机上长按触发 onLongPress（没有悬停，菜单靠长按）。不收 className 和 style。
import { Check, CornerDownRight } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { cn } from '../../lib/utils';
import { type DataAttrs, pickData } from './data-attrs';

const LONG_PRESS_MS = 500;

export function ChoiceRow({
  leading,
  title,
  titleHint,
  time,
  meta,
  tags,
  note,
  menu,
  selected,
  checked,
  indent,
  compact,
  onClick,
  onLongPress,
  ...rest
}: {
  leading?: ReactNode;
  title: ReactNode;
  /** 标题的悬停全文。 */
  titleHint?: string;
  /** 标题行右边的小字（几分钟前）。 */
  time?: ReactNode;
  /** 第二行小字（最后一条消息）。 */
  meta?: ReactNode;
  /** 第二行右边的标签、状态点。 */
  tags?: ReactNode;
  /** 第三行的说明（橙字，比如「没删成：原因」）。 */
  note?: ReactNode;
  /** 行尾菜单。 */
  menu?: ReactNode;
  selected?: boolean;
  /** 多选时这行选没选；undefined 表示不在多选。 */
  checked?: boolean | undefined;
  indent?: boolean;
  compact?: boolean;
  onClick: () => void;
  onLongPress?: () => void;
} & DataAttrs) {
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  const start = () => {
    if (!onLongPress) return;
    longPressed.current = false;
    press.current = setTimeout(() => {
      longPressed.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  };
  const end = () => clearTimeout(press.current);
  return (
    <li
      {...pickData(rest)}
      className={cn(
        'group/row relative flex items-center border-b border-line',
        selected ? 'bg-brand-1' : 'hover:bg-fill-1',
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          onClick();
        }}
        onPointerDown={start}
        onPointerUp={end}
        onPointerLeave={end}
        onContextMenu={(e) => {
          if (onLongPress) e.preventDefault();
        }}
        {...(selected ? { 'aria-current': 'true' as const } : {})}
        {...(checked !== undefined ? { 'aria-pressed': checked } : {})}
        {...(compact ? { title: typeof title === 'string' ? title : undefined } : {})}
        className={cn(
          'flex min-w-0 flex-1 gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-hover max-md:min-h-16',
          compact ? 'flex-col items-center px-1 py-2.5' : 'items-center py-2.5 pr-1',
          !compact && (indent ? 'pl-8' : 'pl-4'),
        )}
      >
        {checked !== undefined ? (
          <span
            aria-hidden
            className={cn(
              'grid size-5 shrink-0 place-items-center rounded-sm border',
              checked ? 'border-brand bg-brand text-on-brand' : 'border-line-2 bg-card',
            )}
          >
            {checked ? <Check className="size-3.5" /> : null}
          </span>
        ) : null}
        {indent ? <CornerDownRight className="-ml-5 size-3.5 shrink-0 text-ink-3" aria-hidden /> : null}
        {leading}
        {compact ? (
          tags
        ) : (
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span
                className="min-w-0 flex-1 truncate text-body font-medium"
                {...(titleHint ? { title: titleHint } : {})}
              >
                {title}
              </span>
              {time ? <span className="shrink-0 text-meta text-ink-3 tabular-nums">{time}</span> : null}
            </span>
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-meta text-ink-3">{meta}</span>
              {tags}
            </span>
            {note ? (
              <span role="status" className="mt-1 block text-meta whitespace-normal text-warn-ink">
                {note}
              </span>
            ) : null}
          </span>
        )}
      </button>
      {menu && !compact ? <span className="shrink-0 pr-2">{menu}</span> : null}
    </li>
  );
}
