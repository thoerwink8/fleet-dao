'use client';

import type { VariantProps } from 'class-variance-authority';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '../../lib/utils';
import { focusRing } from './styles';
import type { toggleVariants } from './toggle';

/**
 * 分段控件（#3509，照 Arco，样稿 canvas/fd3.css `.seg`）：fill-2 底的槽、内边距 2、项间 4；
 * 选中项白底（card）品牌色字 500，没选的灰字。整条默认 32 高（项 28），sm 28 高（项 24）。
 * variant、spacing 是旧参数：样子只有这一种，参数留着不报错。
 */
const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number;
  }
>({
  size: 'default',
  variant: 'default',
  spacing: 0,
});

const ITEM_SIZE = {
  default: 'h-7 max-md:min-h-9',
  sm: 'h-6 max-md:min-h-9',
  lg: 'h-8',
} as const;

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number;
  }) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      className={cn(
        'group/toggle-group inline-flex w-fit items-center gap-1 rounded-sm bg-fill-2 p-0.5',
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size, spacing }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext);
  const s = context.size || size || 'default';

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={s}
      data-spacing={context.spacing}
      className={cn(
        'inline-flex min-w-0 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-3 text-body whitespace-nowrap text-ink-2 transition-colors duration-100 ease-arco hover:text-ink focus-visible:z-10 disabled:cursor-not-allowed disabled:text-ink-3 data-[state=on]:bg-card data-[state=on]:font-medium data-[state=on]:text-brand-ink [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
        focusRing,
        ITEM_SIZE[s],
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
