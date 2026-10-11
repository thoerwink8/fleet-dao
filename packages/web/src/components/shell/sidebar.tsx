import { Database, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NavLink } from 'react-router';
import { brand } from '#brand';
import { useApi, useNotifications } from '../../api/client';
import { useNodeSelection, withNode } from '../../lib/node';
import { pendingCount } from '../../lib/notice-count';
import { cn } from '../../lib/utils';
import { LogoMark } from '../logo';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { NAV, NAV_ITEMS, type NavItem } from './nav';

/** 侧栏角标：数字，或者「!」表示没读成（不拿 0 冒充没事）。 */
function useBadges(): Record<string, number | '!'> {
  const notices = useNotifications('open');
  return {
    '/notifications': notices.data ? pendingCount(notices.data.counts) : notices.error ? '!' : 0,
  };
}

/** 侧栏底部写明数据从哪来：真后端还是假数据。 */
function DataSource({ collapsed }: { collapsed: boolean }) {
  const api = useApi();
  const mock = api.source !== 'http';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-caption text-muted-foreground">
          <Database className={cn('size-3.5 shrink-0', mock && 'text-ink-stall')} aria-hidden />
          {collapsed ? null : (
            <span className="truncate">{mock ? '假数据（演示）' : `${brand.product}后端`}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        {mock
          ? '现在显示的是编的假数据，会自己「动」起来；页面上的操作只改这份假数据。'
          : `数据来自${brand.product}后端（/api），推送走 /api/events。`}
      </TooltipContent>
    </Tooltip>
  );
}

function Item({
  item,
  collapsed,
  badge,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  badge: number | '!';
  onNavigate?: (() => void) | undefined;
}) {
  const Icon = item.icon;
  // 选了远程环境（?node=）时换页不丢掉选择：换到主页、法国页还是看它，换到别的页会整页说明只看得到本台
  const { nodeId } = useNodeSelection();
  const link = (
    <NavLink
      to={withNode(item.to, nodeId)}
      // 别的导航项挂在它下面时（/routing 和 /routing/status）只在正好是它时亮，不然两项一起亮
      end={item.to === '/' || NAV_ITEMS.some((o) => o.to.startsWith(`${item.to}/`))}
      onClick={onNavigate}
      // 手机「更多」抽屉里点的：顶替抽屉压的那条历史，后退回到上一页而不是多停一次（#1820）
      replace={onNavigate !== undefined}
      // 收成图标栏时没有字：名字交给读屏（悬停提示照旧）
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex h-10 items-center md:h-8 gap-2.5 rounded-lg px-2.5 text-sub text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          isActive && 'bg-accent font-medium text-foreground',
          collapsed && 'justify-center px-0',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span className="absolute top-1.5 bottom-1.5 -left-2 w-0.75 rounded-full bg-brand" />
          ) : null}
          <Icon className="size-4 shrink-0" aria-hidden />
          {collapsed ? null : <span className="min-w-0 flex-1 truncate">{item.label}</span>}
          {badge === '!' || badge > 0 ? (
            <span
              title={badge === '!' ? '没读成' : undefined}
              className={cn(
                'num grid min-w-4 place-items-center rounded-full px-1 text-micro leading-4 font-semibold',
                badge === '!' ? 'bg-st-fail text-white' : 'bg-foreground text-background',
                collapsed && 'absolute top-0.5 right-1.5',
              )}
            >
              {badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** 左侧导航。桌面上可以收成一列图标；手机上放进抽屉里。 */
export function SidebarNav({
  collapsed = false,
  onToggle,
  onNavigate,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  const badges = useBadges();
  return (
    <div className="flex h-full flex-col">
      <div
        className={cn('flex h-topbar shrink-0 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}
      >
        <LogoMark className="size-7 shrink-0" />
        {collapsed ? null : (
          <div className="min-w-0 leading-tight">
            <div className="num text-label font-semibold tracking-tight">{brand.name}</div>
            {brand.product === brand.name ? null : (
              <div className="text-caption text-muted-foreground">{brand.product}</div>
            )}
          </div>
        )}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 scrollbar-thin" aria-label="主导航">
        {NAV.map((g) => (
          <div key={g.group} className="mt-3 first:mt-1">
            {collapsed ? (
              <div className="mx-auto my-2 h-px w-6 bg-border" />
            ) : (
              <div className="mb-1 px-2.5 text-caption font-medium text-faint">{g.group}</div>
            )}
            <div className="space-y-0.5">
              {g.items.map((item) => (
                <Item
                  key={item.to}
                  item={item}
                  collapsed={collapsed}
                  badge={badges[item.to] ?? 0}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className={cn('flex shrink-0 items-center gap-2 border-t px-3 py-2.5', collapsed && 'flex-col')}>
        <DataSource collapsed={collapsed} />
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}
