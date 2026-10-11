// 筛选标签条：任务、通知、操作记录共用（#1820）。
// - 手机上每个标签至少 40 高（max-md:min-h-10），手指点得准；电脑上维持原来的紧凑高度。
// - 标签多于一屏时横向滑动，还有内容没滑出来的那一端渐隐，提示「这边还能滑」。
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

/** 一个标签按钮的样式：选中是白底卡片；手机上至少 40 高。 */
export function filterTabClass(selected: boolean): string {
  return cn(
    'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-sub whitespace-nowrap transition-colors max-md:min-h-10',
    selected
      ? 'bg-card font-medium text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground',
  );
}

/** 渐隐带的宽度（rem，跟着字号走，不写死像素）。 */
const FADE = '1.5rem';

export function FilterTrack({
  children,
  className,
  ...aria
}: {
  children: ReactNode;
  className?: string;
  role?: string;
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div
      ref={ref}
      onScroll={measure}
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      style={
        {
          '--fade-start': edges.start ? FADE : '0px',
          '--fade-end': edges.end ? FADE : '0px',
        } as CSSProperties
      }
      className={cn(
        'fade-edges-x scrollbar-thin flex max-w-full overflow-x-auto rounded-lg bg-muted p-1',
        className,
      )}
      {...aria}
    >
      {children}
    </div>
  );
}
