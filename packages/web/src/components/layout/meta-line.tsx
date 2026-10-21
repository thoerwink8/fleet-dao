// 「仓#号 · 开单 1 小时前 · PR #1833」这种点分小字行（12/20 ink-3，照 Arco 的辅助文字）。空项自动跳过，分隔点只画在项之间。
import { Fragment, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function MetaLine({ items, className }: { items: ReactNode[]; className?: string }) {
  const shown = items.filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  return (
    <div className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-ink-3', className)}>
      {shown.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 点分项没有身份，顺序就是它的身份。
        <Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden data-meta-sep>
              ·
            </span>
          ) : null}
          <span className="min-w-0">{item}</span>
        </Fragment>
      ))}
    </div>
  );
}
