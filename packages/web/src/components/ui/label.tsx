'use client';

import { Label as LabelPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../../lib/utils';

/** 表单标签（#3509，照 Arco，样稿 canvas/fd3.css `.form-label`）：14px、字重 400、ink-2。 */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-body font-normal text-ink-2 select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:text-ink-3 peer-disabled:cursor-not-allowed peer-disabled:text-ink-3',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
