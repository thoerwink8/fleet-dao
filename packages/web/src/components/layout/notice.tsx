// 提示条（= Arco 的 Alert，#3509，样稿 canvas/fd3.css `.alert`）：只有三种外观——info 蓝底、warning 橙底、error 红底，字一律正文色，
// 图标用填充色（品牌蓝、警示橙、出错红）。旧 tone 名照收：fail → error，stall → warning，info、done → info。
// fail、stall 用 role=alert（读屏立刻念），info、done 用 role=status。LoadError 的渲染就是它（tone=fail）。
import { CircleAlert, CircleCheck, Info, type LucideIcon, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type NoticeTone = 'fail' | 'stall' | 'info' | 'done';

type Look = 'info' | 'warning' | 'error';

const SKIN: Record<NoticeTone, { look: Look; icon: LucideIcon }> = {
  fail: { look: 'error', icon: CircleAlert },
  stall: { look: 'warning', icon: TriangleAlert },
  info: { look: 'info', icon: Info },
  done: { look: 'info', icon: CircleCheck },
};

const LOOK: Record<Look, { box: string; icon: string }> = {
  info: { box: 'bg-brand-1', icon: 'text-brand' },
  warning: { box: 'bg-warn-1', icon: 'text-warn' },
  error: { box: 'bg-fail-1', icon: 'text-fail' },
};

export function Notice({
  tone = 'info',
  title,
  action,
  children,
  className,
  role,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  /** 右侧的操作，例如「重试」。 */
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** 默认 fail/stall 用 alert、其余 status；页面上本来就常驻、不该打断读屏的提醒（比如设置里某个仓的待办）显式给 status。 */
  role?: 'alert' | 'status';
}) {
  const { look, icon: Icon } = SKIN[tone];
  return (
    <div
      role={role ?? (tone === 'fail' || tone === 'stall' ? 'alert' : 'status')}
      data-tone={tone}
      data-look={look}
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-sm px-4 py-2 text-body text-ink',
        LOOK[look].box,
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Icon className={cn('mt-0.5 size-4 shrink-0', LOOK[look].icon)} aria-hidden />
        <div className="min-w-0">
          {title ? <div className="font-medium">{title}</div> : null}
          {children ? <div>{children}</div> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 self-center">{action}</div> : null}
    </div>
  );
}
