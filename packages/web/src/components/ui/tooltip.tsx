'use client';

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../../lib/utils';
import { motionStop, popSurface } from './styles';

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // 提示和别的浮层同一套底（卡片底、浮层阴影、4 圆角）。Radix 的提示开着时 data-state 是 delayed-open / instant-open，
          // 不是 open，所以进场动画不挂在 data-[state=open] 上：一出现就播（进 200），关时出 100。
          'z-50 w-fit max-w-80 origin-(--radix-tooltip-content-transform-origin) px-3 py-2 text-balance ease-arco',
          popSurface,
          'animate-in fade-in-0 zoom-in-96 duration-200 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-96 data-[state=closed]:duration-100',
          motionStop,
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-tooltip-arrow rotate-45 rounded-sm bg-card fill-card" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
