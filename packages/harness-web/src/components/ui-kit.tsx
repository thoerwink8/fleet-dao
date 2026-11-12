// 全项目统一的模块化 UI 组件库（Card、SectionHeader、Button、Field、Select、Input、StatCard、SegmentedTabs）。
// 解决「没有组件模块化、UI 粗糙」的问题：统一间距、圆角、阴影、边框与交互反馈。
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export function UiCard({
  children,
  className,
  padding = 'md',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
} & React.HTMLAttributes<HTMLElement>) {
  const pad =
    padding === 'none' ? '' : padding === 'sm' ? 'p-3.5' : padding === 'lg' ? 'p-5 md:p-6' : 'p-4 md:p-5';
  return (
    <section
      className={cn(
        'rounded-xl border border-line/80 bg-surface shadow-[0_1px_3px_rgba(15,23,42,0.03),0_1px_2px_rgba(15,23,42,0.02)] transition-shadow',
        pad,
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  );
}

export function UiSectionHeader({
  icon,
  title,
  subtitle,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          {icon ? (
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand [&_svg]:size-4">
              {icon}
            </span>
          ) : null}
          <span className="truncate">{title}</span>
        </div>
        {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
      </div>
      {action ? <div className="flex max-w-full flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function UiButton({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className,
  ...rest
}: {
  variant?: 'primary' | 'secondary' | 'soft' | 'danger' | 'ghost';
  size?: 'xs' | 'sm' | 'md';
  icon?: ReactNode;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const vCls =
    variant === 'primary'
      ? 'border-transparent bg-brand text-white shadow-xs hover:bg-brand-hover'
      : variant === 'soft'
        ? 'border-brand/25 bg-brand-soft text-brand-strong hover:bg-brand hover:text-white'
        : variant === 'danger'
          ? 'border-line bg-surface text-ink-2 hover:border-danger hover:bg-danger-soft hover:text-danger'
          : variant === 'ghost'
            ? 'border-transparent bg-transparent text-muted hover:bg-subtle hover:text-ink'
            : 'border-line bg-surface text-ink-2 shadow-[0_1px_1px_rgba(15,23,42,0.02)] hover:border-line-strong hover:bg-subtle hover:text-ink';
  const sCls =
    size === 'xs'
      ? 'h-6 px-2 text-2xs rounded-md gap-1 [&_svg]:size-3'
      : size === 'sm'
        ? 'h-7.5 px-2.5 text-xs rounded-lg gap-1.5 [&_svg]:size-3.5'
        : 'h-8.5 px-3.5 text-xs rounded-lg gap-1.5 [&_svg]:size-3.5';
  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center justify-center border font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50',
        vCls,
        sCls,
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export function UiField({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
          {label}
        </label>
        {hint ? <span className="text-2xs text-muted">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function UiInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8.5 w-full rounded-lg border border-line bg-surface px-3 text-xs text-ink transition-colors placeholder:text-muted focus:border-brand focus:bg-surface focus:outline-none',
        className,
      )}
      {...rest}
    />
  );
}

export function UiSelect({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-8.5 w-full rounded-lg border border-line bg-surface px-2.5 text-xs text-ink transition-colors focus:border-brand focus:outline-none',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function UiStatCard({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'brand';
}) {
  return (
    <div className="rounded-xl border border-line/80 bg-surface p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.02)]">
      <div className="text-2xs font-medium text-muted">{label}</div>
      <div className={cn('num mt-1 text-sm font-semibold', tone === 'brand' ? 'text-brand' : 'text-ink')}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-2xs text-muted">{sub}</div> : null}
    </div>
  );
}

export function UiSegmentedTabs<T extends string | number>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className={cn(
        'inline-flex flex-wrap items-center gap-1 rounded-lg border border-line bg-subtle p-1',
        className,
      )}
    >
      {options.map(([k, label]) => {
        const active = value === k;
        return (
          <button
            key={String(k)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(k)}
            className={cn(
              'h-7 cursor-pointer rounded-md px-2.5 text-xs transition-all',
              active ? 'bg-surface font-medium text-brand shadow-xs' : 'text-ink-2 hover:text-ink',
            )}
          >
            {label}
          </button>
        );
      })}
    </fieldset>
  );
}
