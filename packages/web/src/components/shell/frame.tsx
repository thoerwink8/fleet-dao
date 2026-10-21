// 外壳的版式（#3509，照 Arco Pro 的 .app）：顶栏 60 横跨全宽，下面左菜单 + 内容区；手机再加底部导航。
// 内容区 page 底色、不限最大宽；面包屑、页头、左右留白由各页的 Page 给（画布、提需求这类整屏的页自己铺满）。
// 样式都在这里（组件层），routes/shell.tsx 只摆数据和状态。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { BottomNav } from './bottom-nav';
import { SidebarNav } from './sidebar';
import { ShellMark, Topbar } from './topbar';

export function AppFrame({
  phone,
  collapsed,
  onToggleMenu,
  onSearch,
  contentId,
  children,
}: {
  phone: boolean;
  /** 左菜单收成 48 宽的图标条。 */
  collapsed: boolean;
  onToggleMenu(): void;
  onSearch(): void;
  /** 正文区的 id（「跳到正文」的落点）。 */
  contentId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-page">
      <Topbar onSearch={onSearch} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {phone ? null : (
          <aside
            data-menu={collapsed ? 'collapsed' : 'open'}
            className={cn(
              'shrink-0 border-r border-line bg-card transition-[width] duration-200 ease-arco',
              collapsed ? 'w-12' : 'w-sidebar',
            )}
          >
            <SidebarNav collapsed={collapsed} onToggle={onToggleMenu} />
          </aside>
        )}
        {/* min-w-0 + overflow-x-hidden：任何一页的内容比正文区宽，都只在自己里面处理，不把整页撑出横向滚动（点验 audit.md，390/768 宽主页被切）。
            tabindex=-1：脚本能聚焦（跳到正文），但不进平时的 Tab 序列。 */}
        <main
          id={contentId}
          tabIndex={-1}
          className="skip-target relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-page scrollbar-thin"
          onMouseDown={(event) => {
            // 点空白不该把焦点抢走：只有「跳到正文」才聚焦正文区本身。
            if (event.target === event.currentTarget) event.preventDefault();
          }}
        >
          {children}
        </main>
      </div>
      {phone ? <BottomNav onSearch={onSearch} /> : null}
    </div>
  );
}

/** 外壳还没进去时的整屏一句话（确认登录、没登录、没确认成）：标志、一句话、下面的小字和按钮。 */
export function ShellScreen({
  title,
  children,
  actions,
}: {
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="grid h-dvh place-items-center bg-page p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center text-body text-ink-3">
        <ShellMark className="size-10" />
        {title ? <p className="text-ink">{title}</p> : null}
        {children}
        {actions ? <div className="flex gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
