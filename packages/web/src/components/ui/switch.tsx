'use client';

import { Switch as SwitchPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../../lib/utils';
import { focusRing } from './styles';

/**
 * 开关（#3509，照 Arco，样稿 canvas/fd3.css `.switch`）：默认 40×24、拇指 16；sm 28×16、拇指 12。
 * 关着 fill-3 底、开着品牌色底，拇指白色；切换 200ms、ease-arco（减少动效时 app.css 把时长归零）。
 */
function Switch({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: 'sm' | 'default';
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        // 手机上可点区域用透明伪元素往外撑到 ≥40（#1837），不改外观
        'peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-arco max-md:before:absolute max-md:before:-inset-3',
        focusRing,
        'disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-6 data-[size=default]:w-10 data-[size=default]:p-1 data-[size=sm]:h-4 data-[size=sm]:w-7 data-[size=sm]:p-0.5 data-[state=checked]:bg-brand data-[state=unchecked]:bg-fill-3',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-on-brand transition-transform duration-200 ease-arco group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=unchecked]:translate-x-0 group-data-[size=default]/switch:data-[state=checked]:translate-x-4 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
