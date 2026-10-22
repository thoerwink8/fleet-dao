// 定高行的滚动窗口（路由页的模型目录、渠道、先后列表，添加模型弹窗）：行高是算死的，只画看得见的几行。
// 业务层只传数字（可视高度、行高、第几行），定位用的 inline style 都收在这里。不收 className 和 style。
// - WindowBox：定高、纵向滚的容器，滚到哪一行由调用方的 onScrollTop 收；fill 是填满父元素（父元素要有确定高度）。
// - WindowList：里面的 ul / ol，总高 = 行数 × 行高，行用 absolute 摆。
// - RowItem：一行的 li。给 top 就是窗口里的绝对定位行，只给 height 是定高行（整页滚），都不给是自然高度。
import type { DragEvent, ReactNode, Ref } from 'react';
import { cn } from '../../lib/utils';

export function WindowBox({
  height,
  fill = false,
  flow = false,
  windowed,
  onScrollTop,
  boxRef,
  attrs,
  children,
}: {
  /** 可视高度（像素）。fill 时忽略。 */
  height?: number;
  fill?: boolean;
  /** 手机宽度：不设内部滚动，行跟着整页滚（桌面仍是 routing-window 高的窗口）。 */
  flow?: boolean;
  windowed?: boolean;
  onScrollTop?: (top: number) => void;
  boxRef?: Ref<HTMLDivElement>;
  /** 额外的 data-* 标记。 */
  attrs?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  if (flow) {
    return (
      <div
        data-page-scroll="true"
        className="h-auto overflow-visible md:h-routing-window md:overflow-y-auto md:overscroll-contain"
      >
        {children}
      </div>
    );
  }
  return (
    <div
      ref={boxRef}
      data-windowed={windowed ? 'true' : undefined}
      {...(attrs ?? {})}
      style={fill || height === undefined ? undefined : { height }}
      className={cn('overflow-y-auto overscroll-contain', fill && 'h-full min-h-0')}
      onScroll={onScrollTop ? (e) => onScrollTop(e.currentTarget.scrollTop) : undefined}
    >
      {children}
    </div>
  );
}

export function WindowList({
  ariaLabel,
  total,
  as = 'ul',
  pending,
  children,
}: {
  ariaLabel: string;
  /** 总高（像素）= 行数 × 行高；不给就是自然高度的普通列表。 */
  total?: number;
  as?: 'ul' | 'ol';
  /** 拖动放下后等后端回话，名单还是预览。 */
  pending?: boolean;
  children: ReactNode;
}) {
  const Tag = as;
  return (
    <Tag
      aria-label={ariaLabel}
      data-pending={pending ? 'true' : undefined}
      style={total === undefined ? undefined : { height: total }}
      className={total === undefined ? undefined : 'relative'}
    >
      {children}
    </Tag>
  );
}

export function RowItem({
  top,
  height,
  selected = false,
  divided = true,
  edge,
  posinset,
  setsize,
  attrs,
  onDragOver,
  onDrop,
  children,
}: {
  /** 窗口里的位置（像素）；给了就是 absolute 摆的行，必须同时给 height。 */
  top?: number;
  height?: number;
  selected?: boolean;
  /** 行与行之间一道细线（默认）。 */
  divided?: boolean;
  /** 拖动中，落点在这一行的上沿还是下沿。 */
  edge?: 'before' | 'after' | undefined;
  posinset?: number;
  setsize?: number;
  attrs?: Record<string, string | undefined>;
  onDragOver?: (e: DragEvent<HTMLLIElement>) => void;
  onDrop?: (e: DragEvent<HTMLLIElement>) => void;
  children: ReactNode;
}) {
  const placed = top !== undefined && height !== undefined;
  const style = placed
    ? { position: 'absolute' as const, left: 0, right: 0, top, height }
    : height !== undefined
      ? { height }
      : undefined;
  return (
    <li
      {...(attrs ?? {})}
      data-selected={selected || undefined}
      data-drop={edge}
      aria-posinset={posinset}
      aria-setsize={setsize}
      style={style}
      className={cn(
        'relative transition-colors duration-100',
        divided && 'border-b border-line last:border-b-0',
        selected ? 'bg-brand-1 hover:bg-brand-1' : 'hover:bg-fill-1',
        edge === 'before' && 'border-t-2 border-t-ink',
        edge === 'after' && 'border-b-2 border-b-ink',
      )}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}
    </li>
  );
}
