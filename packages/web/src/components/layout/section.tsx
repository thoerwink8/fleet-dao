// 区块（= Arco 的 Card，#3509，样稿 canvas/fd3.css `.card` `.card-head` `.card.flush`）：页面里的一块内容，带标题。
// 白底、4 圆角、无阴影无描边，靠浅灰页底分层；内边距 20，头（标题 16/500 在左、操作在右）和正文之间 16。
// flush：正文贴边（放列表和表格），头单独留 16 20 的边、和正文之间 12。
// 最多两层容器（页面 → 区块），区块里用分隔线和行，不再套卡片（规范第五节第 3 条）。两栏并排用 SectionGrid，不嵌套卡片。
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { type LayoutTone, solidClass } from './tone';

export function Section({
  title,
  description,
  actions,
  flush,
  tight,
  toolbar,
  footer,
  variant = 'card',
  tone,
  children,
  className,
  ...rest
}: {
  /** flush 的区块里，头和列表之间一条带边的筛选区（搜索、分段筛选），左右留区块内边距。 */
  toolbar?: ReactNode;
  /** flush 的区块里，列表下面一条带上边线的说明区（「怎么看这些状态」），左右留区块内边距。 */
  footer?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 正文没有内边距，放列表和表格。 */
  flush?: boolean;
  /** 正文左右留区块内边距、上下只留 4：里面是自带行距的列表（行本身有 py）。 */
  tight?: boolean;
  /** card 白底卡片（默认）；plain 无底，只有标题和内容（设置页那种）。 */
  variant?: 'card' | 'plain';
  /** 出问题的区块：左边一道状态色竖线。 */
  tone?: LayoutTone;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<'section'>, 'title' | 'children' | 'className'>) {
  const card = variant === 'card';
  // 区块本身不留内边距的两种：flush（正文贴边，表格、列表）和 tight（正文只留左右）。这两种头单独留边。
  const edge = card && (flush || tight);
  const head = Boolean(title || actions);
  return (
    <section
      data-variant={variant}
      data-tone={tone}
      className={cn(
        'relative min-w-0',
        card && 'overflow-hidden rounded-md bg-card text-ink',
        card && !edge && 'p-section',
        className,
      )}
      {...rest}
    >
      {tone && card ? (
        <span
          aria-hidden
          data-section-rail
          className={cn('absolute inset-y-0 left-0 w-rail', solidClass[tone])}
        />
      ) : null}
      {head ? (
        <header
          className={cn(
            'flex items-center justify-between gap-4',
            !card && 'mb-stack',
            card && !edge && 'mb-4',
            card && edge && 'px-section pt-4',
            card && flush && 'mb-3',
            card && tight && !flush && 'mb-1',
          )}
        >
          <div className="min-w-0">
            {title ? <h2 className="flex items-center gap-2 text-heading text-ink">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-meta text-ink-3">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-3 text-body">{actions}</div> : null}
        </header>
      ) : null}
      {toolbar ? (
        // 没有头的区块（筛选条就是第一行）：toolbar 自己留上边
        <div data-section-toolbar className={cn('border-b border-line px-section pb-3', !head && 'pt-4')}>
          {toolbar}
        </div>
      ) : null}
      <div className={cn(card && tight && !flush && 'px-section py-1')}>{children}</div>
      {footer ? (
        <div data-section-footer className="border-t border-line px-section py-2">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

const COLS = { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3' } as const;

/** 两栏（或三栏）并排的区块：手机上叠成一列，区块之间 16（区块间距令牌）。 */
export function SectionGrid({
  cols = 2,
  children,
  className,
}: {
  cols?: 1 | 2 | 3;
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('grid grid-cols-1 gap-section-gap', COLS[cols], className)}>{children}</div>;
}
