// 编号、路由号、模型 id、提交号的等宽小块。全站只有这里用等宽字体（规范第五节第 2 条）。
// #3509 照 Arco 的行内代码：等宽 13、fill-2 底、2 圆角、左右 4，字 ink-2。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'rounded-sm bg-fill-2 px-1 font-mono text-mono tabular-nums break-all text-ink-2',
        className,
      )}
    >
      {children}
    </code>
  );
}
