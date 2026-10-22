// 栅格（样子照 canvas/fd3.css 的 .grid-2/3/4、.grid-main、.split）。窄屏（lg 以下）一律叠成一列，四列的先退到两列。
// cols 是等宽的几列；preset 是两栏版式：main＝主内容在左、右边一列定宽 360（主区加侧栏），split＝左边一列定宽 360 的列表、右边是详情。
// preset 要刚好两个子节点。不收 className 和 style。
import { Children, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

const COLS = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 lg:grid-cols-2',
  3: 'grid-cols-1 lg:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
} as const;

export type GridProps =
  | { cols: 1 | 2 | 3 | 4; preset?: undefined; children?: ReactNode }
  | { cols?: undefined; preset: 'main' | 'split' | 'side'; children: [ReactNode, ReactNode] };

export function Grid(props: GridProps) {
  if (props.preset !== undefined) {
    const [first, second] = Children.toArray(props.children);
    // side：左边一列页内导航（Anchor，定宽，贴顶），右边是各节（设置页，样稿 .grid-side）
    if (props.preset === 'side') {
      return (
        <div
          data-preset="side"
          className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-settings-shell lg:gap-8"
        >
          <div className="min-w-0">{first}</div>
          <div className="min-w-0">{second}</div>
        </div>
      );
    }
    const main = props.preset === 'main';
    return (
      <div data-preset={props.preset} className="flex min-w-0 flex-col items-start gap-4 lg:flex-row">
        <div className={cn('min-w-0 w-full', main ? 'lg:flex-1' : 'lg:w-90 lg:shrink-0')}>{first}</div>
        <div className={cn('min-w-0 w-full', main ? 'lg:w-90 lg:shrink-0' : 'lg:flex-1')}>{second}</div>
      </div>
    );
  }
  return (
    <div data-cols={props.cols} className={cn('grid gap-4', COLS[props.cols])}>
      {props.children}
    </div>
  );
}
