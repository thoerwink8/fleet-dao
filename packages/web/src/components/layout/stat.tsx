// 指标卡：大号数字（无衬线、等宽数字）+ 白话标签。StatGrid 把一排指标卡摆齐。
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/utils';
import { inkClass, type LayoutTone } from './tone';

export function Stat({
  label,
  value,
  hint,
  icon: Icon,
  to,
  tone,
  className,
  wrapHint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon | undefined;
  to?: string | undefined;
  /** 数字的状态色（出问题的数字标红、标黄）。 */
  tone?: LayoutTone | undefined;
  className?: string | undefined;
  /** 说明折行显示。不传则单行省略。 */
  wrapHint?: boolean | undefined;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between text-meta text-muted-foreground">
        <span>{label}</span>
        {Icon ? <Icon className="size-4" aria-hidden /> : null}
      </div>
      <div className={cn('num mt-2 text-display', tone && inkClass[tone])}>{value}</div>
      {hint ? (
        <div className={cn('mt-2 text-meta text-muted-foreground', wrapHint ? 'break-words' : 'truncate')}>
          {hint}
        </div>
      ) : null}
    </>
  );
  const cls = cn(
    'block rounded-lg border bg-card p-4 shadow-card transition-colors duration-100 hover:border-border-strong',
    className,
  );
  return to ? (
    <Link to={to} data-tone={tone} className={cls}>
      {body}
    </Link>
  ) : (
    <div data-tone={tone} className={cls}>
      {body}
    </div>
  );
}

const COLS = {
  2: 'grid-cols-2',
  3: 'grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
} as const;

export function StatGrid({
  cols = 4,
  children,
  className,
}: {
  cols?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('grid gap-3', COLS[cols], className)}>{children}</div>;
}
