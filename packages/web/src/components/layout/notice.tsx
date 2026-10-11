// 出错、提醒横幅。fail、stall 用 role=alert（读屏立刻念），info、done 用 role=status。LoadError 的渲染就是它（tone=fail）。
import { CircleAlert, CircleCheck, Info, type LucideIcon, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { inkClass, type LayoutTone, lineClass, softClass } from './tone';

export type NoticeTone = 'fail' | 'stall' | 'info' | 'done';

const SKIN: Record<NoticeTone, { tone: LayoutTone; icon: LucideIcon }> = {
  fail: { tone: 'fail', icon: CircleAlert },
  stall: { tone: 'stall', icon: TriangleAlert },
  info: { tone: 'run', icon: Info },
  done: { tone: 'done', icon: CircleCheck },
};

export function Notice({
  tone = 'info',
  title,
  action,
  children,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  /** 右侧的操作，例如「重试」。 */
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const { tone: skin, icon: Icon } = SKIN[tone];
  return (
    <div
      role={tone === 'fail' || tone === 'stall' ? 'alert' : 'status'}
      data-tone={tone}
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-body',
        softClass[skin],
        lineClass[skin],
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Icon className={cn('mt-0.5 size-4 shrink-0', inkClass[skin])} aria-hidden />
        <div className={cn('min-w-0', inkClass[skin])}>
          {title ? <div className="font-medium">{title}</div> : null}
          {children ? <div>{children}</div> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
