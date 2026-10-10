// 顶栏右段的「插槽」：某一页（现在是主页）把自己的状态条、刷新条放进顶栏，省出正文一行。
// 外壳给顶栏造一个空容器并把它登记在这里；页面用 InTopbar 把内容传送进去。
// 没有外壳（单独渲染页面的测试）或者这一档放不下（enabled=false）时，原地渲染 fallback，页面自己不缺东西。
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

interface SlotValue {
  el: HTMLElement | null;
  setEl(el: HTMLElement | null): void;
}

const SlotContext = createContext<SlotValue | null>(null);

export function TopbarSlotProvider({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ el, setEl }), [el]);
  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>;
}

/** 顶栏里放插槽内容的容器：没有页面往里放东西时是空的、不占位。≥1024 才显示（更窄的屏幕顶栏放不下）。 */
export function TopbarSlot({ className }: { className?: string }) {
  const ctx = useContext(SlotContext);
  return (
    <div
      ref={ctx?.setEl}
      data-topbar-slot
      className={cn('hidden min-w-0 flex-1 items-center justify-end gap-3 lg:flex', className)}
    />
  );
}

export function InTopbar({
  enabled,
  children,
  fallback,
}: {
  enabled: boolean;
  children: ReactNode;
  fallback: ReactNode;
}) {
  const ctx = useContext(SlotContext);
  if (!enabled || !ctx) return <>{fallback}</>;
  // 容器还没登记上（外壳第一次渲染）：这一帧什么都不画，登记完立刻补上
  return ctx.el ? createPortal(children, ctx.el) : null;
}
