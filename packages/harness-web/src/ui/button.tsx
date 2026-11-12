import { Slot } from '@radix-ui/react-slot';
import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../lib/cn';

const VARIANT = {
  default: 'bg-brand text-white hover:bg-brand-hover',
  outline: 'border border-line bg-surface text-ink hover:bg-subtle',
  ghost: 'text-ink-2 hover:bg-neutral-soft hover:text-ink',
  danger: 'bg-danger text-white hover:opacity-90',
} as const;

const SIZE = {
  sm: 'h-7 px-2 text-2xs',
  md: 'h-8 px-3 text-xs',
  lg: 'h-10 px-4 text-sm',
  icon: 'size-8',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'md', asChild = false, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...props}
    />
  );
});
