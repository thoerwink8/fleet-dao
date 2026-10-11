// 原生下拉：手机上原生选择器比自绘的好用；样式和 ui/select 的触发器对齐（控件 6px 圆角、桌面 32 高、手机 40 高 16px）。
import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className={cn('relative inline-flex min-w-0', className)}>
      <select
        data-slot="native-select"
        className="h-control w-full min-w-0 appearance-none rounded-md border border-input bg-transparent py-1 pr-8 pl-3 text-body shadow-xs outline-none transition-[color,box-shadow] duration-100 focus-visible:border-ring focus-visible:ring-focus focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive max-md:min-h-10 max-md:text-heading max-md:font-normal"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </span>
  );
}
