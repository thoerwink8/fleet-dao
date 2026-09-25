import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import { ApiError, errorText, useLiveSync, useMe, useNotifications } from '../api/client';
import { loginPath } from '../api/index';
import { LogoMark } from '../components/logo';
import { RepoProvider } from '../components/repo-context';
import { CommandMenu } from '../components/shell/command-menu';
import { demoBlocked } from '../components/shell/nav';
import { SidebarNav } from '../components/shell/sidebar';
import { Topbar } from '../components/shell/topbar';
import { TaskActionsProvider } from '../components/task-actions';
import { Button } from '../components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../components/ui/sheet';
import { isDemo } from '../demo/access';
import { DemoBanner, NotOpen } from '../demo/views';
import { useIsMobile, useLocalState } from '../lib/hooks';
import { cn } from '../lib/utils';

function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-dvh place-items-center bg-background p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center text-sm text-muted-foreground">
        <LogoMark className="size-10" />
        {children}
      </div>
    </div>
  );
}

/** 没登录就不进外壳：401 时 API 层已经在跳登录页，这里只负责别把半截页面露出来。 */
function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.data) return children;
  if (me.isPending) return <Screen>正在确认登录…</Screen>;
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  return (
    <Screen>
      <p className="text-foreground">{unauthenticated ? '要先登录，正在跳到登录页…' : '没能确认登录'}</p>
      {unauthenticated ? null : <p>{errorText(me.error)}</p>}
      <div className="flex gap-2">
        {unauthenticated ? null : (
          <Button size="sm" variant="outline" onClick={() => void me.refetch()}>
            重试
          </Button>
        )}
        <Button asChild size="sm">
          <Link to={loginPath()}>去登录页</Link>
        </Button>
      </div>
    </Screen>
  );
}

/**
 * 新提醒弹一条：要人拍、卡住报警弹；日报只进通知中心。
 * 第一次拉到的都是旧提醒，只记下不弹——打开页面时不该被一串旧提醒淹没。
 */
function useNoticeToasts() {
  const { data } = useNotifications('open');
  const navigate = useNavigate();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!data) return;
    if (!seen.current) {
      seen.current = new Set(data.items.map((n) => n.id));
      return;
    }
    for (const n of data.items) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (n.level === 'daily') continue;
      const show = n.level === 'decision' ? toast.info : toast.warning;
      show(n.title, {
        description: n.body,
        action: { label: '去看看', onClick: () => navigate(n.link ?? '/notifications') },
      });
    }
  }, [data, navigate]);
}

function Frame() {
  const location = useLocation();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useLocalState(`${brand.storagePrefix}sidebar-collapsed`, false);
  const [mobileNav, setMobileNav] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  useLiveSync();
  useNoticeToasts();

  // 演示版：这一页所在的模块没开放，就不渲染它（它的数据也就不去读）。
  const blocked = demoBlocked(location.pathname);
  const fullBleed = location.pathname === '/' && !isMobile && !blocked;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {isDemo() ? <DemoBanner /> : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn(
            'hidden shrink-0 border-r bg-panel transition-[width] duration-200 md:block',
            collapsed ? 'w-[60px]' : 'w-[232px]',
          )}
        >
          <SidebarNav collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onMenu={() => setMobileNav(true)} onSearch={() => setCmdk(true)} />
          <main
            className={cn(
              'relative min-h-0 flex-1',
              fullBleed ? 'overflow-hidden' : 'overflow-y-auto scrollbar-thin',
            )}
          >
            {blocked ? <NotOpen /> : <Outlet />}
          </main>
        </div>
      </div>
      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-[260px] bg-panel p-0">
          <SheetTitle className="sr-only">导航</SheetTitle>
          <SheetDescription className="sr-only">{brand.product}的全部页面</SheetDescription>
          <SidebarNav onNavigate={() => setMobileNav(false)} />
        </SheetContent>
      </Sheet>
      <CommandMenu open={cmdk} onOpenChange={setCmdk} />
    </div>
  );
}

export default function Shell() {
  return (
    <AuthGate>
      <RepoProvider>
        <TaskActionsProvider>
          <Frame />
        </TaskActionsProvider>
      </RepoProvider>
    </AuthGate>
  );
}
