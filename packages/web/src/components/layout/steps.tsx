// 步骤条（参数名照 antd，样子照 canvas/fd3.css 的 .steps .step）。
// 走过的是浅蓝圆里一个勾，现在这步是蓝底白字的序号，没成的是红圈里一个叉，还没到的是灰圈序号。
// status 用 antd 的词：wait、process、finish、error；不写就按 current 推（之前的 finish、current 是 process、之后的 wait）。
// 窄屏（md 以下）竖着排。不收 className 和 style。
import { Check, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type StepStatus = 'wait' | 'process' | 'finish' | 'error';

export interface StepItem {
  title: ReactNode;
  description?: ReactNode;
  status?: StepStatus;
}

const ICON: Record<StepStatus, string> = {
  wait: 'bg-fill-2 text-ink-2',
  process: 'bg-brand text-on-brand',
  finish: 'bg-brand-1 text-brand-ink',
  error: 'bg-fail-1 text-fail-ink',
};

export function Steps({ items, current = 0 }: { items: readonly StepItem[]; current?: number }) {
  const statusOf = (it: StepItem, i: number): StepStatus =>
    it.status ?? (i < current ? 'finish' : i === current ? 'process' : 'wait');
  return (
    <ol className="flex min-w-0 flex-col items-stretch gap-4 md:flex-row md:items-start md:gap-0">
      {items.map((it, i) => {
        const status = statusOf(it, i);
        const last = i === items.length - 1;
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: 步骤的身份就是它的位置。
            key={i}
            data-status={status}
            {...(status === 'process' ? { 'aria-current': 'step' as const } : {})}
            className={cn('flex min-w-0 items-center gap-3', !last && 'md:flex-1')}
          >
            <span
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-body font-medium',
                ICON[status],
              )}
            >
              {status === 'finish' ? (
                <Check aria-hidden className="size-3.5" />
              ) : status === 'error' ? (
                <X aria-hidden className="size-3.5" />
              ) : (
                i + 1
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span
                className={cn(
                  'text-heading whitespace-nowrap',
                  status === 'wait' ? 'text-ink-2' : 'font-medium text-ink',
                )}
              >
                {it.title}
              </span>
              {it.description ? (
                <span className="text-meta whitespace-nowrap text-ink-3">{it.description}</span>
              ) : null}
            </span>
            {last ? null : (
              <span
                aria-hidden
                className={cn(
                  'mx-4 hidden h-px min-w-6 flex-1 md:block',
                  status === 'finish' ? 'bg-brand' : 'bg-line',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
