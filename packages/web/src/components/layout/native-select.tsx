// 原生下拉：手机上原生选择器比自绘的好用；外观和 ui/input、ui/select 的触发器同一套（#3509 照 Arco `.input`：
// fill-2 底无描边、2 圆角、桌面 32 高 14px，悬停 fill-3，聚焦白底品牌色描边；手机 40 高 16px）。
import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import { fieldSurface } from '../ui/styles';

export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className={cn('relative inline-flex min-w-0', className)}>
      <select
        data-slot="native-select"
        className={cn(
          'h-control w-full min-w-0 cursor-pointer appearance-none pr-8 pl-3 text-body max-md:min-h-10 max-md:text-heading max-md:font-normal',
          fieldSurface,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-3"
        aria-hidden
      />
    </span>
  );
}
