// 圆点列表（#3533，更新日志、说明文字里的「- 一条」）：每条前面一个灰圆点，条间 8。不收 className 和 style。
import type { ReactNode } from 'react';
import { type DataAttrs, pickData } from './data-attrs';

export function BulletList({ items, ...rest }: { items: readonly ReactNode[] } & DataAttrs) {
  return (
    <ul {...pickData(rest)} className="flex min-w-0 flex-col gap-2">
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 列表项按文档先后排，顺序就是身份。
        <li key={i} className="flex gap-2.5 text-body text-ink">
          <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}
