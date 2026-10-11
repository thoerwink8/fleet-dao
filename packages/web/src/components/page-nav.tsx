// 页内导航（#1805）：桌面吸在左边竖排，手机吸在顶上变成横向胶囊条。
// 用法：外面套一层 lg:grid-cols-settings-shell；导航在第一格，内容在第二格。
import { cn } from '../lib/utils';

export function PageNav({
  label,
  items,
  className,
}: {
  label: string;
  items: readonly { id: string; label: string }[];
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      data-page-nav
      className={cn(
        // 手机：吸顶的一条横向胶囊，超出时自己横滑（只有这条滑，页面不横滚）。
        'sticky top-0 z-10 -mx-4 flex gap-1.5 overflow-x-auto border-b bg-background/95 px-4 py-2 backdrop-blur scrollbar-thin sm:-mx-6 sm:px-6',
        // 桌面：吸在左边竖排。
        'lg:top-6 lg:mx-0 lg:flex-col lg:gap-0.5 lg:self-start lg:overflow-visible lg:border-b-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none',
        className,
      )}
    >
      {items.map((x) => (
        <a
          key={x.id}
          href={`#${x.id}`}
          className="shrink-0 rounded-full border bg-card px-3 py-1 text-xs whitespace-nowrap text-muted-foreground hover:border-border-strong hover:text-foreground lg:rounded-md lg:border-transparent lg:bg-transparent lg:px-2.5 lg:py-1.5 lg:text-sm lg:hover:bg-muted"
        >
          {x.label}
        </a>
      ))}
    </nav>
  );
}
