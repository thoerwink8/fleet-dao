// 色带（#3533）：列表里夹的一行说明——笔之间「引擎 自测 → 推分支」、返工回合的「为什么返工」、进行中的「接下来」。
// muted 浅灰底（fill-1），danger 淡红底（fail-1，只给异常）。不收 className 和 style；data-* 落在最外层。
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

type DataAttrs = { [K in `data-${string}`]?: string | number | boolean | undefined };

export function Band({
  tone = 'muted',
  children,
  ...rest
}: {
  tone?: 'muted' | 'danger';
  children: ReactNode;
} & DataAttrs &
  Omit<ComponentProps<'div'>, 'className' | 'style' | 'children'>) {
  return (
    <div
      data-tone={tone}
      className={cn(
        'min-w-0 px-section py-1.5 text-meta text-ink-2',
        tone === 'muted' ? 'bg-fill-1' : 'rounded-sm bg-fail-1',
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
