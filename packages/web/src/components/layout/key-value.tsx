// 键值行：「标签：值」成对。rows 是一行一对（标签在左），grid 是几列并排（标签在上）。替掉各页手写的 <dl>。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Code } from './code';
import { inkClass, type LayoutTone } from './tone';

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** 值是编号、模型 id 这类，用等宽小块。 */
  mono?: boolean;
  /** 值的状态色。 */
  tone?: LayoutTone;
  /** 值下面的小字。 */
  hint?: ReactNode;
}

const COLS = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-2 md:grid-cols-3',
  4: 'grid-cols-2 md:grid-cols-4',
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
      className={cn(rows ? 'divide-y divide-border' : cn('grid gap-x-4 gap-y-3', COLS[cols]), className)}
    >
      {items.map((it, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 标签可以是节点，下标就是行的身份。
          key={i}
          data-tone={it.tone}
          className={cn(rows ? 'grid grid-cols-about gap-x-4 py-2 max-md:grid-cols-1' : 'min-w-0')}
        >
          <dt className="text-meta text-muted-foreground">{it.label}</dt>
          <dd className={cn('min-w-0 text-body break-words', it.tone && inkClass[it.tone])}>
            {it.mono ? <Code>{it.value}</Code> : it.value}
            {it.hint ? <div className="text-meta text-muted-foreground">{it.hint}</div> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
