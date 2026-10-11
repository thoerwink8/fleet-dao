// 筛选标签条：唯一一种筛选样式（规范第七节）。任务、通知、操作记录共用（#1820）。
// - 灰底轨道，选中是白底卡片；手机上每个标签至少 40 高，手指点得准；电脑上 28 高。
// - 标签多于一屏时横向滑动，还有内容没滑出来的那一端渐隐，提示「这边还能滑」。
// - 默认是页签（role=tab，aria-selected）；mode="toggle" 是一组按钮（aria-pressed），页签之外的「选一个级别」用。
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { StatusDot } from './status-badge';
import type { LayoutTone } from './tone';

export interface FilterTabItem<Id extends string = string> {
  id: Id;
  label: ReactNode;
  /** 计数；不传就不画。传 null 写「—」（没读到，不拿 0 冒充）。 */
  count?: number | string | null;
  /** 标签前面画这个状态的点。 */
  tone?: LayoutTone;
}

/** 渐隐带的宽度（rem，跟着字号走，不写死像素）。 */
const FADE = '1.5rem';

export function FilterTabs<Id extends string = string>({
  items,
  value,
  onChange,
  mode = 'tabs',
  className,
  ...aria
}: {
  items: readonly FilterTabItem<Id>[];
  value: Id | undefined;
  onChange: (id: Id) => void;
  mode?: 'tabs' | 'toggle';
  className?: string;
  'aria-label': string;
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
      role={mode === 'tabs' ? 'tablist' : 'group'}
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
      {items.map((it) => {
        const selected = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            {...(mode === 'tabs' ? { role: 'tab', 'aria-selected': selected } : { 'aria-pressed': selected })}
            onClick={() => onChange(it.id)}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-body whitespace-nowrap transition-colors duration-100 outline-none focus-visible:ring-focus focus-visible:ring-ring max-md:min-h-10',
              selected
                ? 'bg-card font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {it.tone ? <StatusDot tone={it.tone} className="size-1.5" /> : null}
            {it.label}
            {it.count !== undefined ? (
              <span className="num text-meta text-muted-foreground">{it.count ?? '—'}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
