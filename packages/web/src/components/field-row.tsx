// 字段行（#1805）：标签在左、控件在右一行（md 起标签列 180px），窄了标签在上。
// 一节里的一组字段放进 FieldGroup，字段之间一条细线，一组只写一个说明（写在节标题下）。
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Label } from './ui/label';

/** 一组字段：细线分隔，行高紧凑。 */
export function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl border bg-card px-4', className)} {...props} />;
}

/**
 * 一行字段。给了 onSubmit 就渲染成 form（输入和「保存」同一行提交），否则是 div。
 * hint 写在控件下面（短句）；error 在最下面，带 role=alert。
 */
export function FieldRow({
  label,
  htmlFor,
  hint,
  hintId,
  error,
  errorId,
  children,
  onSubmit,
  formLabel,
  className,
}: {
  label: ReactNode;
  htmlFor?: string | undefined;
  hint?: ReactNode;
  hintId?: string | undefined;
  error?: ReactNode;
  errorId?: string | undefined;
  children: ReactNode;
  onSubmit?: ((e: React.FormEvent<HTMLFormElement>) => void) | undefined;
  formLabel?: string | undefined;
  className?: string | undefined;
}) {
  const cls = cn(
    'grid gap-x-4 gap-y-1 border-b py-2.5 last:border-b-0 md:grid-cols-field md:items-start',
    className,
  );
  const body = (
    <>
      <div className="min-h-8 pt-1.5 text-sm font-medium md:pt-1.5">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-sm leading-snug">
            {label}
          </Label>
        ) : (
          label
        )}
      </div>
      <div className="min-w-0">
        <div className="flex min-h-8 flex-wrap items-center gap-2">{children}</div>
        {hint ? (
          <div id={hintId} className="mt-1 text-caption text-muted-foreground">
            {hint}
          </div>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="mt-1 text-xs text-ink-fail">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
  return onSubmit ? (
    <form onSubmit={onSubmit} aria-label={formLabel} className={cls}>
      {body}
    </form>
  ) : (
    <div className={cls}>{body}</div>
  );
}
