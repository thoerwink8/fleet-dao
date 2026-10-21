// 空状态（#3509，照 Arco，样稿 canvas/fd3.css `.empty`）：一句话说明为什么空，能做什么就给个按钮。替掉 Empty 和各页手写的虚线框。
// section 占一整块：居中，48 的灰圆底图标、标题 16/500、说明 14 灰字（最宽 480），按钮在下面；上下 48 左右 24。
// inline 夹在一行内容里，只有一行灰字。
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
          'flex flex-wrap items-center gap-2 px-section py-stack text-body text-ink-3',
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
        <div className="grid size-12 place-items-center rounded-full bg-fill-2 text-ink-3">
          <Icon className="size-6" aria-hidden />
        </div>
      ) : null}
      <div className="text-heading text-ink">{title}</div>
      {hint ? <div className="max-w-120 text-body text-ink-3">{hint}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
