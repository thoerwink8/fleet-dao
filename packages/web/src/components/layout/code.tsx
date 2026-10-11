// 编号、路由号、模型 id、提交号的等宽小块。全站只有这里用等宽字体（规范第五节第 2 条）。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'rounded-sm bg-muted px-1 py-0.5 font-mono text-meta tabular-nums break-all text-foreground',
        className,
      )}
    >
      {children}
    </code>
  );
}
