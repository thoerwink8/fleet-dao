// 编号、路由号、模型 id、提交号的等宽小块。全站只有这里用等宽字体（规范第五节第 2 条）。
// #3509 照 Arco 的行内代码：等宽 13、fill-2 底、2 圆角、左右 4，字 ink-2。
// block：多行原文（请求、响应、探针原文）：整块、保留换行、最高 160 滚动。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Code({
  children,
  className,
  block,
}: {
  children: ReactNode;
  className?: string;
  /** 多行原文：画成一整块，保留换行，太长在块里滚。 */
  block?: boolean;
}) {
  if (block) {
    return (
      <pre className="max-h-40 max-w-full overflow-auto rounded-sm bg-fill-2 px-3 py-2 font-mono text-mono break-all whitespace-pre-wrap text-ink-2">
        {children}
      </pre>
    );
  }
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
