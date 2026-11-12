import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-8 min-w-0 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-brand',
        className,
      )}
      {...props}
    />
  );
});
