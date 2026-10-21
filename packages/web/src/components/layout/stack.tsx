// 横竖排（样子照 canvas/fd3.css 的 .stack）。替掉页面里手写的 flex + gap。
// 不收 className 和 style：要间距选 gap，要对齐选 align、justify，要换行选 wrap。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** 间距四档（设计值 8 / 12 / 16 / 24）。其余间距留给组件内部。 */
export type StackGap = 'sm' | 'md' | 'lg' | 'xl';

const GAP: Record<StackGap, string> = { sm: 'gap-2', md: 'gap-3', lg: 'gap-4', xl: 'gap-6' };
const ALIGN = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  baseline: 'items-baseline',
  stretch: 'items-stretch',
} as const;
const JUSTIFY = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
} as const;

export function Stack({
  direction = 'vertical',
  gap = 'lg',
  align,
  justify,
  wrap,
  children,
}: {
  /** vertical（默认）一列往下排，horizontal 一行往右排。 */
  direction?: 'vertical' | 'horizontal';
  /** 间距：sm 8、md 12、lg 16（默认）、xl 24。 */
  gap?: StackGap;
  align?: keyof typeof ALIGN;
  justify?: keyof typeof JUSTIFY;
  /** 排不下换行（横排用）。 */
  wrap?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-direction={direction}
      className={cn(
        'flex min-w-0',
        direction === 'vertical' ? 'flex-col' : 'flex-row',
        GAP[gap],
        align && ALIGN[align],
        justify && JUSTIFY[justify],
        wrap && 'flex-wrap',
      )}
    >
      {children}
    </div>
  );
}
