// 字段行（#1805）：标签在左、控件在右一行（md 起标签列 180px），窄了标签在上。
// #3509 照 Arco 的表单项（样稿 canvas/fd3.css `.form` `.form-item`）：标签 14px ink-2 字重 400，和控件第一行对齐；
// 说明 12px 灰字、出错 12px 红字，都在控件下面；项和项之间 20，不画分隔线、不套框。
// 一节里的一组字段放进 FieldGroup，一组只写一个说明（写在节标题下）。
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Label } from '../ui/label';

/** 一组字段：项间 20（每行自带上下 10），不画框——它本来就放在区块（Section）里，不再套一层。 */
export function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div data-field-group className={cn('flex flex-col', className)} {...props} />;
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
    'grid gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0 md:grid-cols-field md:items-start',
    className,
  );
  const body = (
    <>
      <div className="min-h-control pt-1.5 text-body text-ink-2 max-md:min-h-0 max-md:pt-0">
        {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : label}
      </div>
      <div className="min-w-0">
        <div className="flex min-h-control flex-wrap items-center gap-2">{children}</div>
        {hint ? (
          <div id={hintId} className="mt-1 text-meta text-ink-3">
            {hint}
          </div>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="mt-1 text-meta text-fail-ink">
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
