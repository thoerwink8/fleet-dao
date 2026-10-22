// 表单（参数名照 antd，样子照 canvas/fd3.css 的 .form .form-item）：Form 一列往下排，FormItem 是「左标签右控件」。
// layout="horizontal"（默认）：md 以上标签在左占 160、控件在右；窄屏和 layout="vertical" 标签在上。
// 必填的标签前面一个红星；help 是控件下面的灰字，error 是红字（读屏会读，role=alert）。不收 className 和 style。
import type { FormEvent, ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Form({
  onSubmit,
  children,
  'aria-label': ariaLabel,
  method,
}: {
  /** 密码这类不能拼进地址的表单写 post：万一页面脚本没接住提交，浏览器也不会走 GET。 */
  method?: 'post';
  /** 回车或点提交键时调用，已经 preventDefault。 */
  onSubmit?: () => void;
  children: ReactNode;
  'aria-label'?: string;
}) {
  return (
    <form
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      {...(method ? { method } : {})}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit?.();
      }}
      className="flex flex-col gap-5"
    >
      {children}
    </form>
  );
}

export function FormItem({
  label,
  required,
  help,
  error,
  layout = 'horizontal',
  htmlFor,
  helpId,
  errorId,
  children,
}: {
  /** help、error 的元素 id，给控件的 aria-describedby 指过来。 */
  helpId?: string;
  errorId?: string;
  label: ReactNode;
  required?: boolean;
  help?: ReactNode;
  /** 校验没过的原因；有它就不显示 help。 */
  error?: ReactNode;
  layout?: 'horizontal' | 'vertical';
  /** 控件的 id，标签点一下聚焦它。 */
  htmlFor?: string;
  children: ReactNode;
}) {
  const horizontal = layout === 'horizontal';
  return (
    <div
      data-layout={layout}
      data-invalid={error ? '' : undefined}
      className={cn('flex flex-col gap-2', horizontal && 'md:flex-row md:items-start md:gap-4')}
    >
      {/* biome-ignore lint/a11y/noLabelWithoutControl: 控件是 children，由调用方用 htmlFor 指过来。 */}
      <label
        {...(htmlFor ? { htmlFor } : {})}
        className={cn(
          'text-body whitespace-nowrap text-ink-2',
          horizontal && 'md:flex md:h-control md:w-40 md:shrink-0 md:items-center',
        )}
      >
        {required ? (
          <span aria-hidden className="mr-1 text-fail-ink">
            *
          </span>
        ) : null}
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {children}
        {error ? (
          <span role="alert" id={errorId} className="text-meta text-fail-ink">
            {error}
          </span>
        ) : help ? (
          <span id={helpId} className="text-meta text-ink-3">
            {help}
          </span>
        ) : null}
      </div>
    </div>
  );
}
