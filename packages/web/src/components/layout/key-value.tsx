// 键值对（= Arco 的 Descriptions，#3509，样稿 canvas/fd3.css `.desc`）：「标签 值」成对，标签 ink-3 在左、值 ink，间隔 12。
// rows 一对一行（标签列等宽对齐），grid 几列并排（列间 24、行间 16）。替掉各页手写的 <dl>。
// 值的颜色只给异常：tone 是 fail 标红、stall / doubt 标橙，别的照正文色。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Code } from './code';
import { anomalyInkClass, type LayoutTone } from './tone';

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** 值是编号、模型 id 这类，用等宽小块。 */
  mono?: boolean;
  /** 值的状态（只有异常上色）。 */
  tone?: LayoutTone;
  /** 值下面的小字。 */
  hint?: ReactNode;
}

const COLS = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-4',
} as const;

export function KeyValue({
  items,
  layout = 'rows',
  cols = 2,
  className,
}: {
  items: readonly KeyValueItem[];
  layout?: 'rows' | 'grid';
  cols?: 1 | 2 | 3 | 4;
  className?: string;
}) {
  const rows = layout === 'rows';
  return (
    <dl
      data-layout={layout}
      className={cn(
        'grid gap-y-3 text-body',
        rows ? 'grid-cols-1' : cn('gap-x-6 gap-y-4', COLS[cols]),
        className,
      )}
    >
      {items.map((it, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 标签可以是节点，下标就是行的身份。
          key={i}
          data-tone={it.tone}
          className={cn(
            'flex min-w-0 gap-3',
            rows && 'grid grid-cols-about max-md:grid-cols-1 max-md:gap-0.5',
          )}
        >
          <dt className={cn('shrink-0 text-ink-3', !rows && 'whitespace-nowrap')}>{it.label}</dt>
          <dd className={cn('min-w-0 break-words text-ink', anomalyInkClass(it.tone))}>
            {it.mono ? <Code>{it.value}</Code> : it.value}
            {it.hint ? <div className="text-meta text-ink-3">{it.hint}</div> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
