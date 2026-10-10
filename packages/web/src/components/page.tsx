import { errMessage } from '@fleet-dao/shared/util';
import { useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

/** 后台页面的外框：标题、一句说明、右上角的操作。 */
export function Page({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'fd-rise mx-auto w-full max-w-cockpit px-4 pt-5 pb-16 sm:px-6 lg:px-8 lg:pt-7',
        className,
      )}
    >
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 lg:flex-nowrap">
        <div className="min-w-0 lg:flex-1">
          <h1 className="text-title font-semibold tracking-tight">{title}</h1>
          {description ? (
            <div className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex max-w-full flex-wrap items-center gap-2 lg:shrink-0">{actions}</div>
        ) : null}
      </header>
      {children}
    </div>
  );
}

/** 一块面板：带标题的卡片。 */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('rounded-xl border bg-card text-card-foreground shadow-card-edge', className)}>
      {title || actions ? (
        <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** 指标卡：大号等宽数字 + 白话标签。 */
export function Stat({
  label,
  value,
  hint,
  icon: Icon,
  to,
  accent,
  className,
  wrapHint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon | undefined;
  to?: string | undefined;
  /** 数字的颜色类，例如 text-ink-stall。 */
  accent?: string | undefined;
  className?: string | undefined;
  /** 说明折行显示。不传则单行省略，别的页的指标卡维持原样。 */
  wrapHint?: boolean | undefined;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        {Icon ? <Icon className="size-4 opacity-60" aria-hidden /> : null}
      </div>
      <div className={cn('num mt-2 text-stat leading-none font-semibold tracking-tight', accent)}>
        {value}
      </div>
      {hint ? (
        <div className={cn('mt-2 text-xs text-muted-foreground', wrapHint ? 'break-words' : 'truncate')}>
          {hint}
        </div>
      ) : null}
    </>
  );
  const cls = cn(
    'block rounded-xl border bg-card p-4 shadow-card-edge transition-colors hover:border-border-strong',
    className,
  );
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Empty({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="text-sm font-medium">{title}</div>
      {hint ? <div className="max-w-sm text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 占位骨架没有身份，下标就是它的身份。
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/**
 * 查询出错时的一行说明：不编造，写明没查成、哪一块没查成，并带一个「重试」按钮。
 * 给了 onRetry 就点它；没给（多数页面）= 把眼下所有读失败的查询再读一遍（哪一块挂了就重读哪一块），不用每个页面各接一个 refetch。
 */
export function LoadError({
  error,
  what,
  onRetry,
  text,
}: {
  error: unknown;
  what?: string | undefined;
  onRetry?: (() => void) | undefined;
  /** 整句说明。给了就不再拼「哪一块没读成」（两条失败合成一条横幅时用）。 */
  text?: string | undefined;
}) {
  const qc = useQueryClient();
  const retry = onRetry ?? (() => void qc.refetchQueries({ predicate: (q) => q.state.status === 'error' }));
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-st-fail/40 bg-st-fail/10 px-3 py-2 text-sm text-ink-fail"
    >
      <span>{text ?? `${what ? `${what}没读成` : '没查成'}：${errMessage(error)}`}</span>
      <Button type="button" size="xs" variant="outline" onClick={retry}>
        重试
      </Button>
    </div>
  );
}
