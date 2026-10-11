// 区块：页面里的一块内容，带标题。最多两层容器（页面 → 区块），区块里用分隔线和行，不再套卡片（规范第五节第 3 条）。
// 两栏并排用 SectionGrid，不嵌套卡片。
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { type LayoutTone, solidClass } from './tone';

export function Section({
  title,
  description,
  actions,
  flush,
  tight,
  variant = 'card',
  tone,
  children,
  className,
  ...rest
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 正文没有内边距，放列表和表格。 */
  flush?: boolean;
  /** 正文左右留区块内边距、上下只留 4：里面是自带行距的列表（行本身有 py）。 */
  tight?: boolean;
  /** card 有边框和底（默认）；plain 无边框，只有标题和内容（设置页那种）。 */
  variant?: 'card' | 'plain';
  /** 出问题的区块：左边一道状态色竖线。 */
  tone?: LayoutTone;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<'section'>, 'title' | 'children' | 'className'>) {
  const card = variant === 'card';
  return (
    <section
      data-variant={variant}
      data-tone={tone}
      className={cn(
        'relative min-w-0',
        card && 'overflow-hidden rounded-lg border bg-card text-card-foreground shadow-card',
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
      {title || actions ? (
        <header
          className={cn(
            'flex items-start justify-between gap-stack',
            card ? 'border-b px-section py-stack' : 'pb-stack',
          )}
        >
          <div className="min-w-0">
            {title ? <h2 className="text-heading">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-meta text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(card && !flush && (tight ? 'px-section py-1' : 'p-section'))}>{children}</div>
    </section>
  );
}

const COLS = { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3' } as const;

/** 两栏（或三栏）并排的区块：手机上叠成一列，区块之间 16；桌面（lg）起用区块间距令牌（标准 24，紧凑 16）。 */
export function SectionGrid({
  cols = 2,
  children,
  className,
}: {
  cols?: 1 | 2 | 3;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 lg:gap-section-gap', COLS[cols], className)}>{children}</div>
  );
}
