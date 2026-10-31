import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type Tone = 'neutral' | 'brand' | 'warning' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-ink-2',
  brand: 'bg-brand-soft text-brand-strong',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

/** 小标签：浅底配同色系深字；正常态用 neutral，只有异常才上 warning / danger。 */
export function Chip({
  tone = 'neutral',
  mono,
  title,
  className,
  children,
}: {
  tone?: Tone;
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
