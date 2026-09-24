import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/utils';
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
        'fd-rise mx-auto w-full max-w-[1320px] px-4 pt-5 pb-16 sm:px-6 lg:px-8 lg:pt-7',
        className,
      )}
    >
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
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
    <section
      className={cn(
        'rounded-xl border bg-card text-card-foreground shadow-[0_1px_0_var(--border)]',
        className,
      )}
    >
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
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon | undefined;
  to?: string | undefined;
  /** 数字的颜色类，例如 text-st-stall。 */
  accent?: string | undefined;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        {Icon ? <Icon className="size-4 opacity-60" aria-hidden /> : null}
      </div>
      <div className={cn('num mt-2 text-[28px] leading-none font-semibold tracking-tight', accent)}>
        {value}
      </div>
      {hint ? <div className="mt-2 truncate text-xs text-muted-foreground">{hint}</div> : null}
    </>
  );
  const cls =
    'block rounded-xl border bg-card p-4 shadow-[0_1px_0_var(--border)] transition-colors hover:border-border-strong';
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

/** 查询出错时的一行说明：不编造，写明没查成、哪一块没查成。 */
export function LoadError({ error, what }: { error: unknown; what?: string | undefined }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-st-fail/40 bg-st-fail/10 px-3 py-2 text-sm text-st-fail"
    >
      {what ? `${what}没读成` : '没查成'}：{error instanceof Error ? error.message : String(error)}
    </div>
  );
}

/** 有仓的看板没读成：写明是哪几个仓，别让「少了一个仓」看起来像「没有需求」。 */
export function BoardsError({ failed, error }: { failed: { name: string }[]; error: unknown }) {
  const what = failed.length ? `仓 ${failed.map((r) => r.name).join('、')} 的需求` : '仓列表';
  return <LoadError what={what} error={error} />;
}
