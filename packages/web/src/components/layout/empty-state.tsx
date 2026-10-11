// 空状态：一句话说明为什么空，能做什么就给个按钮。替掉 Empty 和各页手写的虚线框。
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  size = 'section',
  className,
}: {
  icon?: LucideIcon | undefined;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  /** section 占一整块（居中、带圆形图标）；inline 夹在一行内容里，只有一行字。 */
  size?: 'section' | 'inline';
  className?: string;
}) {
  if (size === 'inline') {
    return (
      <div
        data-size="inline"
        className={cn(
          'flex flex-wrap items-center gap-2 px-4 py-3 text-body text-muted-foreground',
          className,
        )}
      >
        {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
        <span>{title}</span>
        {hint ? <span className="text-meta">{hint}</span> : null}
        {action}
      </div>
    );
  }
  return (
    <div
      data-size="section"
      className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}
    >
      {Icon ? (
        <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </div>
      ) : null}
      <div className="text-body font-medium">{title}</div>
      {hint ? <div className="max-w-sm text-meta text-muted-foreground">{hint}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
