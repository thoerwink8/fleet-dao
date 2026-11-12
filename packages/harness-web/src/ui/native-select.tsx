import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/** 给必须走原生 select 的地方（批次切换的 e2e 用 selectOption）。会话页不用它。 */
export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function NativeSelect({ className, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'h-8 min-w-0 max-w-full cursor-pointer rounded-md border border-line bg-surface px-2 text-xs text-ink',
          className,
        )}
        {...props}
      />
    );
  },
);
