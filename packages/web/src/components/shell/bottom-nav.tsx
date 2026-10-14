// 手机底部导航：主页、更多（打开导航抽屉，其余页面都在里面；决定 0093 导航降级，主页三块就是要看的全部）。
// 每项至少 40×40，实际按钮占满整条（h-14），拇指够得着；待处理的数挂在「更多」上（通知中心在里面）。
import { Home, Menu } from 'lucide-react';
import { NavLink } from 'react-router';
import { useNotifications } from '../../api/client';
import { useNodeSelection, withNode } from '../../lib/node';
import { pendingCount } from '../../lib/notice-count';
import { cn } from '../../lib/utils';

const ITEMS = [{ to: '/', label: '主页', icon: Home }] as const;

const cell =
  'relative flex h-14 min-w-10 flex-1 flex-col items-center justify-center gap-0.5 text-meta text-muted-foreground transition-colors active:bg-accent';

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
              <Icon className="size-5" aria-hidden />
              {label}
            </>
          )}
        </NavLink>
      ))}
      <button type="button" onClick={onMore} className={cell} aria-label="更多，打开全部页面">
        <span className="relative">
          <Menu className="size-5" aria-hidden />
          {badge !== 0 ? (
            <span
              className={cn(
                'num absolute -top-1.5 left-3 grid min-w-4 place-items-center rounded-full px-1 text-meta font-semibold',
                badge === '!' ? 'bg-destructive text-destructive-foreground' : 'bg-st-human text-background',
              )}
            >
              {badge}
            </span>
          ) : null}
        </span>
        更多
      </button>
    </nav>
  );
}
