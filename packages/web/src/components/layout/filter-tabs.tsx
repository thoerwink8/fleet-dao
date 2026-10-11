// 筛选标签条：唯一一种筛选样式（规范第七节）。任务、通知、操作记录共用（#1820）。
// - 灰底轨道，选中用 selected 令牌（前景 10%），不再用白底反显；次级筛选（variant="secondary"）没有轨道；手机上每个标签至少 40 高，手指点得准；电脑上比控件高少 4（标准 28，紧凑 24）。
// - 标签多于一屏时横向滑动，还有内容没滑出来的那一端渐隐，提示「这边还能滑」。
// - 默认是页签（role=tab，aria-selected）；mode="toggle" 是一组按钮（aria-pressed），页签之外的「选一个级别」用。
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
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

export interface FilterTabGroup<Id extends string = string> {
  key: string;
  /** 组头：写在这一组前面的小标题（「不是流程里的一段」）。第一组通常不写。 */
  heading?: ReactNode;
  /** 组尾一句灰字（「对题：在对话里做，不选路」）。 */
  note?: ReactNode;
  items: readonly FilterTabItem<Id>[];
  'aria-label': string;
}

/**
 * 几组同一类的次级筛选排成一行（#1904 起分组说明写在组头上）：组和组之间一道细竖线，后一组前面写组头小标题。
 * 手机上放不下就换行，组头留在自己那一组前面，不悬在半空。每组各是一个 FilterTabs（同一个选中值）。
 */
export function FilterTabGroups<Id extends string = string>({
  groups,
  value,
  onChange,
  mode = 'toggle',
  className,
}: {
  groups: readonly FilterTabGroup<Id>[];
  value: Id | undefined;
  onChange: (id: Id) => void;
  mode?: 'tabs' | 'toggle';
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2', className)}>
      {groups.map((g, i) => (
        <div
          key={g.key}
          data-tab-group={g.key}
          className={cn(
            'flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1',
            i > 0 && 'md:border-l md:pl-3',
          )}
        >
          {g.heading ? (
            <span className="shrink-0 text-meta text-muted-foreground" data-tab-group-heading>
              {g.heading}
            </span>
          ) : null}
          <FilterTabs
            mode={mode}
            variant="secondary"
            aria-label={g['aria-label']}
            items={g.items}
            value={value}
            onChange={onChange}
            className="min-w-0"
          />
          {g.note ? <span className="text-meta text-muted-foreground">{g.note}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** 渐隐带的宽度（rem，跟着字号走，不写死像素）。 */
const FADE = '1.5rem';

export function FilterTabs<Id extends string = string>({
  items,
  value,
  onChange,
  mode = 'tabs',
  variant = 'primary',
  idPrefix,
  className,
  ...aria
}: {
  items: readonly FilterTabItem<Id>[];
  value: Id | undefined;
  onChange: (id: Id) => void;
  mode?: 'tabs' | 'toggle';
  /** primary 灰底轨道（页面的主筛选）；secondary 没有轨道，只有选中那个有底（同一页里的次级筛选，不和主筛选抢）。 */
  variant?: 'primary' | 'secondary';
  /** 给页签一个 id（`前缀-选项id`），页签对应的面板用 aria-labelledby 指它。 */
  idPrefix?: string;
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

  // 页签的键盘：左右方向键、Home、End 在页签间移动（循环），只有选中的页签在 Tab 序里。
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (mode !== 'tabs') return;
    const at = items.findIndex((it) => it.id === value);
    let to: number;
    if (e.key === 'ArrowRight') to = (at + 1) % items.length;
    else if (e.key === 'ArrowLeft') to = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = items.length - 1;
    else return;
    const next = items[to];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    ref.current?.querySelectorAll<HTMLElement>('[role=tab]')[to]?.focus();
  };

  return (
    <div
      ref={ref}
      role={mode === 'tabs' ? 'tablist' : 'group'}
      onScroll={measure}
      data-variant={variant}
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      style={
        {
          '--fade-start': edges.start ? FADE : '0px',
          '--fade-end': edges.end ? FADE : '0px',
        } as CSSProperties
      }
      className={cn(
        'fade-edges-x scrollbar-thin flex max-w-full overflow-x-auto',
        variant === 'primary' ? 'rounded-lg bg-muted p-1' : 'gap-1',
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
            {...(mode === 'tabs'
              ? {
                  role: 'tab',
                  'aria-selected': selected,
                  tabIndex: selected || value === undefined ? 0 : -1,
                  ...(idPrefix ? { id: `${idPrefix}-${it.id}` } : {}),
                }
              : { 'aria-pressed': selected })}
            onClick={() => onChange(it.id)}
            onKeyDown={onKeyDown}
            className={cn(
              'inline-flex h-[calc(var(--spacing-control)-0.25rem)] shrink-0 items-center gap-1.5 rounded-md px-3 text-body whitespace-nowrap transition-colors duration-100 outline-none focus-visible:ring-focus focus-visible:ring-ring max-md:min-h-10 max-md:min-w-10 max-md:justify-center',
              selected
                ? 'bg-selected font-medium text-foreground'
                : variant === 'primary'
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
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
