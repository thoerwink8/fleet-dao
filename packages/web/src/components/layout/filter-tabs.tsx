// 筛选标签条：唯一一种筛选样式（规范第七节）。任务、通知、操作记录共用（#1820）。
// - #3509 照 Arco（样稿 canvas/fd3.css `.tabs` `.tab` `.tab-count`）：主筛选是下划线页签——40 高、项间 32、底下一道 line，
//   选中品牌色字 500 加 2px 品牌色线，计数是灰底小圆角（选中时 brand-1 底）；
//   次级筛选（variant="secondary"）没有轨道，28 高、选中 fill-2 底品牌色字。手机上每个标签至少 40 高，手指点得准。
// - 标签多于一屏时横向滑动，还有内容没滑出来的那一端渐隐，提示「这边还能滑」。
// - 默认是页签（role=tab，aria-selected）；mode="toggle" 是一组按钮（aria-pressed），页签之外的「选一个级别」用。
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { type DataAttrs, pickData } from './data-attrs';
import { StatusDot } from './status-badge';
import type { LayoutTone } from './tone';

export interface FilterTabItem<Id extends string = string> {
  id: Id;
  label: ReactNode;
  /** 计数；不传就不画。传 null 写「—」（没读到，不拿 0 冒充）。 */
  count?: number | string | null;
  /** 标签前面画这个状态的点。 */
  tone?: LayoutTone;
  /** 挂在这一项按钮上的 data-*（测试、点验按它找）。 */
  data?: DataAttrs;
}

export interface FilterTabGroup<Id extends string = string> {
  key: string;
  /** 组头：写在这一组前面的小标题（「不是流程里的一段」）。第一组通常不写。 */
  heading?: ReactNode;
  /** 组尾一项只读的说明（FilterTabNote：「对题」，悬停看「在对话里做，不选路」）。 */
  note?: ReactNode;
  items: readonly FilterTabItem<Id>[];
  'aria-label': string;
}

/**
 * 几组同一类的次级筛选排成一行（#1904 起分组说明写在组头上）：组和组之间一道细竖线，后一组前面写组头小标题。
 * 组头留在自己那一组前面，不悬在半空。每组各是一个 FilterTabs（同一个选中值）。
 * 任何宽度都是一行；lg 以下放不下就整排横向滑动，不折成第二行（#1914 第 4、5 轮：页签一层、用途一层，不再三层）。
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
    <div
      // 任何宽度都是一行（#1914 第 5 轮：768 宽后一组折到第二行、竖线落在行首）；lg 以下放不下就横滑，右端渐隐提示还能往右滑
      style={{ '--fade-end': FADE } as CSSProperties}
      className={cn(
        // relative：读屏用的 sr-only（绝对定位）以这条为容器、跟着一起裁，不把主区撑宽
        'scrollbar-thin relative flex min-w-0 flex-nowrap items-center gap-x-3 max-lg:fade-edges-x max-lg:overflow-x-auto',
        className,
      )}
    >
      {groups.map((g, i) => (
        <div
          key={g.key}
          data-tab-group={g.key}
          className={cn('flex shrink-0 flex-nowrap items-center gap-x-2', i > 0 && 'border-l pl-3')}
        >
          {g.heading ? (
            <span className="shrink-0 text-meta text-ink-3" data-tab-group-heading>
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
          {g.note}
        </div>
      ))}
    </div>
  );
}

/**
 * 筛选条里一项只读的说明（「对题」）：和选项同高、同样的字，但不能点、更淡；说明全文在悬停和读屏里，不另占一行。
 */
export function FilterTabNote({ label, detail }: { label: string; detail: string }) {
  return (
    <span
      data-tab-note
      title={`${label}：${detail}`}
      className="inline-flex h-7 shrink-0 cursor-help items-center px-3 text-body whitespace-nowrap text-ink-3 max-md:min-h-10"
    >
      {label}
      <span className="sr-only">：{detail}</span>
    </span>
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
  /** primary 下划线页签（页面的主筛选）；secondary 没有轨道，只有选中那个有底（同一页里的次级筛选，不和主筛选抢）。 */
  variant?: 'primary' | 'secondary' | 'segmented';
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
        'fade-edges-x scrollbar-thin flex max-w-full overflow-x-auto overflow-y-hidden',
        // primary：下划线页签，底下一道 line（画成内阴影，选中项的 2px 蓝线盖在上面）；secondary：项间 4，没有轨道
        variant === 'primary' && 'gap-8 shadow-[inset_0_-1px_0_var(--line)]',
        variant === 'secondary' && 'gap-1',
        // 分段控件（fd3 `.seg`）：灰底槽，选中的是白底品牌色字；平的，不浮起、不带阴影
        variant === 'segmented' && 'w-fit gap-1 rounded-sm bg-fill-2 p-0.5',
        className,
      )}
      {...aria}
    >
      {items.map((it) => {
        const selected = it.id === value;
        const count =
          it.count !== undefined ? (
            <span
              data-tab-count
              className={cn(
                'num inline-block h-4.5 min-w-5 rounded-full px-1.5 text-center text-meta font-normal',
                selected && variant === 'primary' ? 'bg-brand-1 text-brand-ink' : 'bg-fill-2 text-ink-2',
              )}
            >
              {it.count ?? '—'}
            </span>
          ) : null;
        return (
          <button
            key={it.id}
            type="button"
            {...pickData(it.data ?? {})}
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
              'inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-body whitespace-nowrap transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-hover max-md:min-h-10 max-md:min-w-10 max-md:justify-center',
              variant === 'segmented'
                ? cn(
                    'h-7 rounded-sm px-3',
                    selected ? 'bg-card font-medium text-brand-ink' : 'text-ink-2 hover:text-ink',
                  )
                : variant === 'primary'
                  ? // Arco 页签（fd3 `.tab`）：40 高、左右 2，底下 2px 线；选中品牌色字 500、品牌色线
                    cn(
                      'h-row border-b-2 px-0.5',
                      selected
                        ? 'border-brand font-medium text-brand-ink'
                        : 'border-transparent text-ink-2 hover:text-ink',
                    )
                  : // 次级筛选：28 高、2 圆角；选中 fill-2 底品牌色字
                    cn(
                      'h-7 rounded-sm px-3',
                      selected
                        ? 'bg-fill-2 font-medium text-brand-ink'
                        : 'text-ink-2 hover:bg-fill-1 hover:text-ink',
                    ),
            )}
          >
            {it.tone ? <StatusDot tone={it.tone} className="size-1.5" /> : null}
            {it.label}
            {count}
          </button>
        );
      })}
    </div>
  );
}
