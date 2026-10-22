// 标题（页面和业务组件里的 h1–h3 都从这里拿，不写 <h2>）：level 1 是页面标题档（20、600），2 是区块标题（16），3 是小标题（14、字重 500）。
// truncate：一行放不下用省略号，悬停给全文。不收 className 和 style。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { type DataAttrs, pickData } from './data-attrs';

const LEVEL = {
  1: 'text-title text-ink',
  2: 'text-heading text-ink',
  3: 'text-body font-medium text-ink',
} as const;

export function Title({
  level = 2,
  truncate,
  title,
  children,
  ...rest
}: {
  level?: 1 | 2 | 3;
  truncate?: boolean;
  /** 悬停给全文（truncate 时用）。 */
  title?: string;
  children: ReactNode;
} & DataAttrs) {
  const Tag = `h${level}` as const;
  return (
    <Tag
      {...(title !== undefined ? { title } : {})}
      {...pickData(rest)}
      className={cn(LEVEL[level], truncate && 'min-w-0 truncate')}
    >
      {children}
    </Tag>
  );
}
