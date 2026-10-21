// 页内导航（样子照 canvas/fd3.css 的 .anchor）：设置页左边那一列，点哪项滚到哪一节，跟着滚动高亮当前这节。
// 左边一道细线，当前这项线变蓝、字变蓝加粗。lg 以上贴着顶部跟着页面走，窄屏排成一行。不收 className 和 style。
import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';

export interface AnchorItem {
  /** 目标元素的 id（不带 #）。 */
  id: string;
  label: string;
}

export function Anchor({ items }: { items: readonly AnchorItem[] }) {
  const [active, setActive] = useState(items[0]?.id);

  // 哪一节最靠近视口顶部就高亮哪一节；没有 IntersectionObserver（旧环境、测试）就只靠点击。
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = items.find((it) => seen.get(it.id));
        if (first) setActive(first.id);
      },
      { rootMargin: '0px 0px -60% 0px' },
    );
    for (const it of items) {
      const el = document.getElementById(it.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [items]);

  return (
    <nav aria-label="本页目录" className="flex flex-row flex-wrap gap-1 lg:sticky lg:top-4 lg:flex-col">
      {items.map((it) => {
        const on = active === it.id;
        return (
          <a
            key={it.id}
            href={`#${it.id}`}
            {...(on ? { 'aria-current': 'location' as const } : {})}
            onClick={() => setActive(it.id)}
            className={cn(
              'block border-l-2 px-3 py-1 text-body transition-colors',
              on ? 'border-brand font-medium text-brand-ink' : 'border-line text-ink-2 hover:text-ink',
            )}
          >
            {it.label}
          </a>
        );
      })}
    </nav>
  );
}
