// 密码输入栏：带标签、「显示 / 隐藏」按钮、提示和错误（登录页和设置页「账密」一节共用）。
// 浏览器和密码管理器靠 autocomplete 认栏：登录用 current-password，设新密码用 new-password（web.dev 登录表单指南）；
// 不拦粘贴（密码管理器要粘贴，NIST SP 800-63B 3.1.1.2）。密码只活在这个组件的 value 里，不写日志、不进地址。
import { Eye, EyeOff } from 'lucide-react';
import type { Ref } from 'react';
import { useState } from 'react';
import { cn } from '../lib/utils';
import { FieldRow } from './field-row';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  maxLength: number;
  /** 这一栏的错误（显示在输入框下面，读屏软件会把它和输入框连起来读）。 */
  error?: string | null | undefined;
  /** 常驻的提示（比如最低长度）：只提示，不替人定规则。 */
  hint?: string | undefined;
  readOnly?: boolean | undefined;
  inputRef?: Ref<HTMLInputElement> | undefined;
  className?: string | undefined;
  /** stack：标签在上（登录页）；row：标签左、控件右一行（设置页，#1805）。 */
  layout?: 'stack' | 'row' | undefined;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  maxLength,
  error,
  hint,
  readOnly,
  inputRef,
  className,
  layout = 'stack',
}: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  const box = (
    <div className={cn('relative', layout === 'row' && 'w-full max-w-sm')}>
      <Input
        ref={inputRef}
        id={id}
        name={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={maxLength}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className="pr-10"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`${shown ? '隐藏' : '显示'}${label}`}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
        className="absolute top-0.5 right-0.5 size-8 text-muted-foreground"
      >
        {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </Button>
    </div>
  );
  if (layout === 'row') {
    return (
      <FieldRow
        label={label}
        htmlFor={id}
        hint={hint}
        hintId={`${id}-hint`}
        error={error}
        errorId={`${id}-error`}
        className={className}
      >
        {box}
      </FieldRow>
    );
  }
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {box}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-ink-fail">
          {error}
        </p>
      ) : null}
    </div>
  );
}
