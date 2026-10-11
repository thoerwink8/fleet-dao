// 页内导航（#1805）：桌面吸在左边竖排，手机吸在顶上变成一排筛选标签（FilterTabs，#1853）。
// 用法：外面套一层 lg:grid-cols-settings-shell；导航在第一格，内容在第二格。
import { useEffect, useState } from 'react';
import { cn } from '../lib/utils';
import { FilterTabs } from './layout/filter-tabs';

export function PageNav({
  label,
  items,
  className,
}: {
  label: string;
  items: readonly { id: string; label: string }[];
  className?: string;
}) {
  const [active, setActive] = useState<string | undefined>(items[0]?.id);

  // 跟着滚动：哪一节的上沿最先过了吸顶条，就亮哪一个。
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const seen = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) seen.add(e.target.id);
          else seen.delete(e.target.id);
        }
        const first = items.find((x) => seen.has(x.id));
        if (first) setActive(first.id);
      },
      { rootMargin: '-56px 0px -60% 0px' },
    );
    for (const x of items) {
      const el = document.getElementById(x.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  const go = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
    history.replaceState(null, '', `#${id}`);
  };

  return (
    <nav
      aria-label={label}
      data-page-nav
      className={cn(
        // 手机：吸顶的一条标签，超出时自己横滑（只有这条滑，页面不横滚）。
        'sticky top-0 z-10 -mx-4 border-b bg-background px-4 py-2 sm:-mx-6 sm:px-6',
        // 桌面：吸在左边竖排。
        'lg:top-6 lg:mx-0 lg:self-start lg:border-b-0 lg:bg-transparent lg:p-0',
        className,
      )}
    >
      <FilterTabs
        mode="toggle"
        aria-label={label}
        items={items}
        value={active}
        onChange={go}
        className="lg:hidden"
      />
      <ul className="hidden flex-col gap-0.5 lg:flex">
        {items.map((x) => (
          <li key={x.id}>
            <a
              href={`#${x.id}`}
              className="flex rounded-md px-2.5 py-1.5 text-body text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {x.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
