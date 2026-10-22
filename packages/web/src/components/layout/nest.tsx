// 缩进一级（#3533）：左边一道细线，里面的东西是上面那件的子内容（子代理说的话、它的调用）。不收 className 和 style。
import type { ComponentProps, ReactNode } from 'react';

type DataAttrs = { [K in `data-${string}`]?: string | number | boolean | undefined };

export function Nest({
  children,
  ...rest
}: { children: ReactNode } & DataAttrs & Omit<ComponentProps<'div'>, 'className' | 'style' | 'children'>) {
  return (
    <div className="ml-4 min-w-0 border-l-2 border-line pl-3" {...rest}>
      {children}
    </div>
  );
}
