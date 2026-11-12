import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type BadgeTone = 'neutral' | 'brand' | 'warning' | 'danger' | 'success';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-soft text-ink-2',
  brand: 'bg-brand-soft text-brand-strong',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  success: 'bg-success-soft text-success',
};

/** 小标签。正常态用 neutral；异常才用 warning / danger；运行中用 success。 */
export function Badge({
  tone = 'neutral',
  mono,
  title,
  className,
  children,
}: {
  tone?: BadgeTone;
  mono?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 text-2xs leading-5',
        mono && 'font-mono',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
