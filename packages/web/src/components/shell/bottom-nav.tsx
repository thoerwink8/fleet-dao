// 手机底部导航（<768，照 Phone.dc.html）：工作台、通知、任务、更多四格，每格占满一份宽、高 56，拇指够得着。
// 「更多」往上弹一个菜单：法国、路由、额度、提需求、设置，和「搜全部页面」（⌘K 面板，不进菜单的页都在里面）。
// 选了远程环境时，只在本台有的页在菜单里置灰并写明（悬停提示），不点进去再看整页说明。
import { Ellipsis, Search } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { useNodeSelection, withNode } from '../../lib/node';
import { cn } from '../../lib/utils';
import { isRemotePage } from '../node-notice';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { activeMenu, NAV_FOOT, NAV_OPS, NAV_TOP } from './nav';
import { CountBadge, useNoticeBadge } from './sidebar';

const TABS = NAV_TOP.slice(0, 3);
const MORE = [...NAV_OPS.items, ...NAV_TOP.slice(3), NAV_FOOT];

const cell =
  'relative flex h-14 min-w-10 flex-1 flex-col items-center justify-center gap-0.5 text-meta text-ink-3 transition-colors duration-100 active:bg-fill-2';

export function BottomNav({ onSearch }: { onSearch(): void }) {
  const { nodeId } = useNodeSelection();
  const { pathname } = useLocation();
  const active = activeMenu(pathname);
  const badge = useNoticeBadge();
  const moreActive = MORE.some((m) => m.to === active);
  return (
    <nav
      aria-label="底部导航"
      data-bottom-nav
      className="flex shrink-0 border-t border-line bg-card pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={withNode(to, nodeId)}
          aria-current={active === to ? 'page' : undefined}
          className={cn(cell, active === to && 'font-medium text-brand-ink')}
        >
          <span className="relative">
            <Icon className="size-5" aria-hidden />
            {to === '/notifications' ? (
              <CountBadge value={badge} className="absolute -top-1.5 left-3 h-4 min-w-4 px-1" />
            ) : null}
          </span>
          {label}
        </Link>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(cell, moreActive && 'font-medium text-brand-ink')}
            aria-label="更多，打开其余页面"
          >
            <Ellipsis className="size-5" aria-hidden />
            更多
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-52">
          {MORE.map(({ to, label, icon: Icon }) => {
            const locked = nodeId !== null && !isRemotePage(to);
            return (
              <DropdownMenuItem
                key={to}
                asChild={!locked}
                disabled={locked}
                title={locked ? '远程环境下只读，这页要去那台上看' : undefined}
              >
                {locked ? (
                  <>
                    <Icon aria-hidden />
                    {label}
                  </>
                ) : (
                  <Link to={withNode(to, nodeId)} aria-current={active === to ? 'page' : undefined}>
                    <Icon aria-hidden />
                    {label}
                  </Link>
                )}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSearch}>
            <Search aria-hidden />
            搜全部页面
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
