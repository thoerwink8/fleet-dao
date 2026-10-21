'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { Toggle as TogglePrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../../lib/utils';
import { focusRing } from './styles';

/**
 * 按下 / 松开的单个筛选钮（#3509，照 Arco 的可选标签）：平时透明底灰字、悬停 fill-2；按下品牌浅底（brand-1）品牌色字。
 * outline 多一道 line 描边。尺寸同按钮：sm 28、默认 32、lg 36；手机上至少 40 高。
 * 放进 ToggleGroup 时样子由分段控件（toggle-group.tsx）接管。
 */
const toggleVariants = cva(
  `inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-sm border border-transparent text-body font-normal whitespace-nowrap text-ink-2 transition-colors duration-100 ease-arco ${focusRing} hover:bg-fill-2 hover:text-ink disabled:cursor-not-allowed disabled:bg-transparent disabled:text-ink-3 data-[state=on]:bg-brand-1 data-[state=on]:text-brand-ink [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border-line bg-transparent data-[state=on]:border-brand',
      },
      size: {
        default: 'h-control min-w-control px-3 max-md:min-h-10',
        sm: 'h-7 min-w-7 px-3 max-md:min-h-10',
        lg: 'h-9 min-w-9 px-4',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
