import type * as React from 'react';
import { cn } from '../../lib/utils';
import { fieldSurface } from './styles';

/**
 * 输入框（#3509，照 Arco，样稿 canvas/fd3.css `.input`）：32 高、左右 12、2 圆角，fill-2 底无描边，聚焦白底品牌色描边。
 * 手机上 40 高、16px 字（防 iOS 点进去自动放大），桌面（md 起）14px。
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-control w-full min-w-0 px-3 text-heading font-normal max-md:min-h-10 md:text-body',
        fieldSurface,
        'file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-body file:font-medium file:text-ink',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
