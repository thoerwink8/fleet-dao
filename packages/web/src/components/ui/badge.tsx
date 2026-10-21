import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../../lib/utils';
import { focusRing } from './styles';

/**
 * 小标签（#3509，照 Arco，样稿 canvas/fd3.css `.tag`）：24 高、左右 8、2 圆角、12px 500。
 * 颜色只给异常：带底色的只有灰（default、secondary）、橙（warning）、红（destructive）三种。
 */
const badgeVariants = cva(
  `inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-2 text-meta font-medium whitespace-nowrap transition-colors duration-100 ${focusRing} [&>svg]:pointer-events-none [&>svg]:size-3`,
  {
    variants: {
      variant: {
        default: 'bg-fill-2 text-ink-2 [a&]:hover:bg-fill-3',
        secondary: 'bg-fill-2 text-ink-2 [a&]:hover:bg-fill-3',
        warning: 'bg-warn-1 text-warn-ink',
        destructive: 'bg-fail-1 text-fail-ink',
        outline: 'border-line text-ink-2 [a&]:hover:bg-fill-2',
        ghost: 'text-ink-2 [a&]:hover:bg-fill-2',
        link: 'text-brand-ink underline-offset-4 [a&]:hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
