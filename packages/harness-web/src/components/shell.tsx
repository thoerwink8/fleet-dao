import {
  CircleCheckBig,
  Ellipsis,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  Workflow,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { cn } from '../lib/cn';

interface NavItem {
  to: string;
  label: string;
  short: string;
  icon: ReactNode;
  end?: boolean;
}

// 五块一级信息架构（specs/3752 第五节）：会话工作台、任务波次图、决策卡、法国运维、设置。
// 这一片只有会话工作台有内容，其余四块是占位页，写明哪一片做。
export const NAV: NavItem[] = [
  { to: '/', label: '会话', short: '会话', icon: <MessagesSquare />, end: false },
  { to: '/work', label: '任务', short: '任务', icon: <Workflow /> },
  { to: '/decide', label: '决策', short: '决策', icon: <CircleCheckBig /> },
  { to: '/ops', label: '法国运维', short: '运维', icon: <Server /> },
  { to: '/settings', label: '设置', short: '设置', icon: <Settings /> },
];

// 手机底部四格：会话、任务、决策、更多（运维、设置收进更多）
const TABS: NavItem[] = [
  NAV[0] as NavItem,
  NAV[1] as NavItem,
  NAV[2] as NavItem,
  { to: '/more', label: '更多', short: '更多', icon: <Ellipsis /> },
];

const readFold = (): boolean => {
  try {
    return localStorage.getItem('harness-nav-fold') === '1';
  } catch {
    return false;
  }
};

function isOn(item: NavItem, path: string): boolean {
  if (item.to === '/') return path === '/' || path.startsWith('/s/');
  if (item.to === '/more') return path === '/more' || path.startsWith('/ops') || path.startsWith('/settings');
  return path === item.to || path.startsWith(`${item.to}/`);
}

/** 电脑：左侧导航（可收成一列图标）；手机（768 以下）：底部标签栏。内容区自己管顶栏。 */
export function Shell() {
  const [fold, setFold] = useState(readFold);
  const toggle = () => {
    setFold(!fold);
    try {
      localStorage.setItem('harness-nav-fold', fold ? '0' : '1');
    } catch {
      /* 存不了就只管这一次 */
    }
  };
  const path = useLocation().pathname;
  return (
    <div
      className={cn(
        'min-h-dvh md:grid',
        fold ? 'md:grid-cols-[64px_minmax(0,1fr)]' : 'md:grid-cols-[208px_minmax(0,1fr)]',
      )}
    >
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface md:flex">
        <div
          className={cn(
            'flex h-(--bar-h) shrink-0 items-center gap-2.5 border-b border-line',
            fold ? 'justify-center' : 'px-5',
          )}
        >
          <div className="grid size-7 shrink-0 place-items-center rounded-md bg-brand text-sm font-medium text-white">
            F
          </div>
          {fold ? null : (
            <div className="min-w-0">
              <div className="truncate text-sm font-medium leading-5">驾驶舱</div>
              <div className="truncate text-2xs leading-4 text-muted">新内核 · 只读</div>
            </div>
          )}
        </div>
        <nav aria-label="主导航" className="flex flex-1 flex-col gap-1 p-2">
          {NAV.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end ?? false}
              title={fold ? it.label : undefined}
              aria-label={fold ? it.label : undefined}
              aria-current={isOn(it, path) ? 'page' : undefined}
              className={() =>
                cn(
                  'flex h-10 items-center gap-3 rounded-md text-sm transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0',
                  fold ? 'justify-center' : 'px-3',
                  isOn(it, path)
                    ? 'bg-brand-soft font-medium text-brand'
                    : 'text-ink-2 hover:bg-neutral-soft hover:text-ink',
                )
              }
            >
              {it.icon}
              {fold ? null : <span className="truncate">{it.label}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-2">
          <button
            type="button"
            onClick={toggle}
            aria-label={fold ? '展开导航' : '收起导航'}
            title={fold ? '展开导航' : undefined}
            className={cn(
              'flex h-10 w-full cursor-pointer items-center gap-3 rounded-md text-sm text-muted hover:bg-neutral-soft hover:text-ink [&_svg]:size-[18px]',
              fold ? 'justify-center' : 'px-3',
            )}
          >
            {fold ? (
              <PanelLeftOpen />
            ) : (
              <>
                <PanelLeftClose />
                收起侧栏
              </>
            )}
          </button>
        </div>
      </aside>
      <main className="flex min-h-dvh min-w-0 flex-col pb-14 md:pb-0">
        <Outlet />
      </main>
      <nav
        aria-label="底部导航"
        className="fixed inset-x-0 bottom-0 z-40 grid h-14 grid-cols-4 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {TABS.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            className={() =>
              cn(
                'flex flex-col items-center justify-center gap-0.5 text-2xs [&_svg]:size-5',
                isOn(it, path) ? 'font-medium text-brand' : 'text-muted',
              )
            }
          >
            {it.icon}
            {it.short}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** 页面顶栏：固定 56px 一行不折行，左标题、中间控件（放不下横向滑）、右边操作。 */
export function PageBar({
  title,
  leading,
  children,
  extra,
}: {
  title: ReactNode;
  leading?: ReactNode;
  children?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-(--bar-h) shrink-0 items-center gap-3 border-b border-line bg-surface/90 px-3 backdrop-blur-md md:px-6">
      {leading}
      <h1 className="min-w-0 shrink truncate text-base font-medium">{title}</h1>
      <div className="scrollbar-none -my-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-0.5 py-1">
        {children}
      </div>
      {extra ? <div className="flex shrink-0 items-center gap-2">{extra}</div> : null}
    </header>
  );
}

/** 还没做的那几块：说明是哪一片、现在去哪看。 */
export function BlockPlaceholder({ title, slice, note }: { title: string; slice: string; note: string }) {
  return (
    <>
      <PageBar title={title} />
      <div className="grid flex-1 place-items-center p-6">
        <div className="max-w-sm rounded-lg border border-line bg-surface p-6 text-center">
          <div className="text-base font-medium">{title}还没做</div>
          <p className="mt-2 text-sm text-ink-2">{note}</p>
          <p className="mt-3 text-2xs text-muted">{slice}</p>
        </div>
      </div>
    </>
  );
}

export function MorePage() {
  return (
    <>
      <PageBar title="更多" />
      <div className="flex flex-col gap-2 p-3">
        {[NAV[3], NAV[4]].map((it) =>
          it ? (
            <NavLink
              key={it.to}
              to={it.to}
              className="flex h-12 items-center gap-3 rounded-lg border border-line bg-surface px-4 text-sm [&_svg]:size-[18px] [&_svg]:text-muted"
            >
              {it.icon}
              {it.label}
            </NavLink>
          ) : null,
        )}
      </div>
    </>
  );
}
