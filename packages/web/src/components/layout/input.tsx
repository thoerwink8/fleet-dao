// 输入框、多行输入、标签（包 ui/input、ui/textarea、ui/label，#3533；页面只能从这里拿，不引 ui/、不写 <input>）。
// 样子照 canvas/fd3.css `.input` `textarea.input` `.form-label`：fill-2 底无描边、聚焦白底品牌色描边，桌面 32 高 14px，手机 40 高 16px。
// 参数照原生 input / textarea / label（onChange 收事件），不收 className 和 style；宽度用 width 档位：
// full（默认，撑满）、xs（定宽 88，百分数、时间）、sm（定宽 160）、md（定宽 240）、search（搜索框那一档）。
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Input as BaseInput } from '../ui/input';
import { Label as BaseLabel } from '../ui/label';
import { Textarea as BaseTextarea } from '../ui/textarea';

export type InputWidth = 'full' | 'xs' | 'sm' | 'md' | 'search';

const WIDTH: Record<InputWidth, string> = {
  full: '',
  xs: 'w-22',
  sm: 'w-40',
  md: 'w-60',
  search: 'max-w-search',
};

export function Input({
  width = 'full',
  suffix,
  ...props
}: Omit<ComponentProps<'input'>, 'className' | 'style'> & {
  width?: InputWidth;
  /** 输入框右边框内的小按钮（密码的显示/隐藏）：给 iconOnly 的 Button。 */
  suffix?: ReactNode;
}) {
  if (suffix === undefined) return <BaseInput className={cn(WIDTH[width])} {...props} />;
  return (
    <span data-input-suffix className={cn('relative block w-full', WIDTH[width])}>
      <BaseInput className="pr-10" {...props} />
      <span className="absolute top-0 right-0.5 flex h-control items-center max-md:min-h-10">{suffix}</span>
    </span>
  );
}

export function Textarea({
  width = 'full',
  ...props
}: Omit<ComponentProps<'textarea'>, 'className' | 'style'> & { width?: InputWidth }) {
  return <BaseTextarea className={cn(WIDTH[width])} {...props} />;
}

export function Label(props: Omit<ComponentProps<typeof BaseLabel>, 'className' | 'style'>) {
  return <BaseLabel {...props} />;
}
