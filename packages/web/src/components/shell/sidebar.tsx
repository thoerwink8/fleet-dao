// 左菜单（#3509，照 Arco Pro 的 .menu）：白底 220 宽，上面四项（工作台、通知、任务、提需求），「运维」一组（法国、路由、额度），
// 最底下设置和收起按钮。选中项浅蓝底、蓝字；通知挂待处理件数（红底白字，读不成写「!」，不拿 0 冒充没事）。
// 收起时是 48 宽的图标条，名字交给悬停提示和读屏。不进菜单的页在 nav.ts 的 NAV_HIDDEN，在那些页时亮它挂靠的那一项。
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { useNotifications } from '../../api/client';
import { useNodeSelection, withNode } from '../../lib/node';
import { pendingCount } from '../../lib/notice-count';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { activeMenu, NAV_FOOT, NAV_OPS, NAV_TOP, type NavItem } from './nav';

/**
 * 通知的待处理件数：数字，或者「!」表示没读成。选了远程环境时不挂（提醒是本台的数据，和顶栏不露铃铛同一条）。
 */
export function useNoticeBadge(): number | '!' {
  const notices = useNotifications('open');
  const { nodeId } = useNodeSelection();
  if (nodeId !== null) return 0;
  return notices.data ? pendingCount(notices.data.counts) : notices.error ? '!' : 0;
}

/** 红底白字的计数（.menu-count / .nav-badge 同一种）。0 不画。 */
export function CountBadge({ value, className }: { value: number | '!'; className?: string | undefined }) {
  if (value === 0) return null;
  return (
    <span
      title={value === '!' ? '没读成' : undefined}
      className={cn(
        'num inline-grid h-5 min-w-5 place-items-center rounded-full bg-badge px-1.5 text-meta font-medium text-on-brand',
        className,
      )}
    >
      {value === '!' ? '!' : value > 99 ? '99+' : value}
    </span>
  );
}

function Item({
  item,
  collapsed,
  active,
  badge = 0,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
  badge?: number | '!';
}) {
  const Icon = item.icon;
  // 选了远程环境（?node=）时换页不丢掉选择：换到工作台、法国页还是看它，换到别的页整页说明只看得到本台
  const { nodeId } = useNodeSelection();
  const link = (
    <Link
      to={withNode(item.to, nodeId)}
      aria-current={active ? 'page' : undefined}
      // 收成图标条时没有字：名字交给读屏（悬停提示照旧）
      aria-label={collapsed ? item.label : undefined}
      data-active={active || undefined}
      className={cn(
        'relative flex h-10 shrink-0 items-center gap-3 rounded-sm px-3 text-body text-ink-2 transition-colors duration-100',
        'hover:bg-fill-2 hover:text-ink',
        active && 'bg-brand-1 font-medium text-brand-ink hover:bg-brand-1 hover:text-brand-ink',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {collapsed ? null : <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      <CountBadge
        value={badge}
        className={collapsed ? 'absolute -top-0.5 right-0 h-4 min-w-4 px-1' : undefined}
      />
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** 桌面左菜单。collapsed = 48 宽的图标条；onToggle 是底部的收起 / 展开按钮。 */
export function SidebarNav({ collapsed = false, onToggle }: { collapsed?: boolean; onToggle?: () => void }) {
  const { pathname } = useLocation();
  const active = activeMenu(pathname);
  const notices = useNoticeBadge();
  const item = (it: NavItem) => (
    <Item
      key={it.to}
      item={it}
      collapsed={collapsed}
      active={active === it.to}
      badge={it.to === '/notifications' ? notices : 0}
    />
  );
  return (
    <nav
      aria-label="主导航"
      className={cn(
        'flex h-full flex-col gap-1 overflow-y-auto pt-2 pb-4 scrollbar-thin',
        collapsed ? 'px-1' : 'px-2',
      )}
    >
      {NAV_TOP.map(item)}
      {collapsed ? (
        <div aria-hidden className="mx-auto my-2 h-px w-6 shrink-0 bg-line" />
      ) : (
        <div className="shrink-0 px-3 pt-3 pb-1 text-meta text-ink-3">{NAV_OPS.group}</div>
      )}
      {NAV_OPS.items.map(item)}
      <div className="mt-auto flex shrink-0 flex-col gap-1 border-t border-line pt-2">
        {item(NAV_FOOT)}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? '展开菜单' : '收起菜单'}
            title={collapsed ? '展开菜单' : '收起菜单'}
            className={cn(
              'flex h-8 shrink-0 items-center rounded-sm text-ink-3 transition-colors duration-100 hover:bg-fill-2 hover:text-ink',
              collapsed ? 'justify-center' : 'gap-3 px-3 text-body',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <>
                <PanelLeftClose className="size-4" aria-hidden />
                <span>收起</span>
              </>
            )}
          </button>
        ) : null}
      </div>
    </nav>
  );
}
