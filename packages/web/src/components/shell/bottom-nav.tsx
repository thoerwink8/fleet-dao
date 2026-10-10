// 手机底部导航：主页、任务、通知、更多（打开原来的导航抽屉，其余页面都在里面）。
// 四项每项至少 40×40，实际按钮占满整条（h-14），拇指够得着；通知带待处理角标。
import { Bell, Home, ListChecks, Menu } from 'lucide-react';
import { NavLink } from 'react-router';
import { useNotifications } from '../../api/client';
import { useNodeSelection, withNode } from '../../lib/node';
import { pendingCount } from '../../lib/notice-count';
import { cn } from '../../lib/utils';

const ITEMS = [
  { to: '/', label: '主页', icon: Home },
  { to: '/tasks', label: '任务', icon: ListChecks },
  { to: '/notifications', label: '通知', icon: Bell },
] as const;

const cell =
  'relative flex h-14 min-w-10 flex-1 flex-col items-center justify-center gap-0.5 text-caption text-muted-foreground transition-colors active:bg-accent';

export function BottomNav({ onMore }: { onMore(): void }) {
  const { nodeId } = useNodeSelection();
  const notices = useNotifications('open');
  const badge = notices.data ? pendingCount(notices.data.counts) : notices.error ? '!' : 0;
  return (
    <nav
      aria-label="底部导航"
      data-bottom-nav
      className="flex shrink-0 border-t bg-panel pb-[env(safe-area-inset-bottom)]"
    >
      {ITEMS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={withNode(to, nodeId)}
          end={to === '/'}
          className={({ isActive }) => cn(cell, isActive && 'font-medium text-foreground')}
        >
          {({ isActive }) => (
            <>
              {isActive ? <span className="absolute top-0 h-0.5 w-8 rounded-full bg-brand" /> : null}
              <span className="relative">
                <Icon className="size-5" aria-hidden />
                {to === '/notifications' && badge !== 0 ? (
                  <span
                    className={cn(
                      'num absolute -top-1.5 left-3 grid min-w-4 place-items-center rounded-full px-1 text-micro leading-4 font-semibold',
                      badge === '!' ? 'bg-st-fail text-white' : 'bg-st-human text-white',
                    )}
                  >
                    {badge}
                  </span>
                ) : null}
              </span>
              {label}
            </>
          )}
        </NavLink>
      ))}
      <button type="button" onClick={onMore} className={cell} aria-label="更多，打开全部页面">
        <Menu className="size-5" aria-hidden />
        更多
      </button>
    </nav>
  );
}
