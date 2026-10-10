import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import { ApiError, errorText, useLiveSync, useMe, useNotifications } from '../api/client';
import { loginPath } from '../api/index';
import { LogoMark } from '../components/logo';
import { isRemotePage, OnlyLocalNotice } from '../components/node-notice';
import { RepoProvider } from '../components/repo-context';
import { BottomNav } from '../components/shell/bottom-nav';
import { CommandMenu } from '../components/shell/command-menu';
import { SidebarNav } from '../components/shell/sidebar';
import { Topbar } from '../components/shell/topbar';
import { TopbarSlotProvider } from '../components/shell/topbar-slot';
import { TaskActionsProvider } from '../components/task-actions';
import { Button } from '../components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../components/ui/sheet';
import { useLocalState } from '../lib/hooks';
import { useNodeSelection } from '../lib/node';
import { cn } from '../lib/utils';
import { useNavRoom, usePhone } from '../lib/viewport';

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

/**
 * 没登录就不进外壳：401 时 API 层已经在跳登录页，这里只负责别把半截页面露出来。
 * 确认登录的同时外壳和页面已经挂上（看不见）：它们的读取和 /api/me 一起发出去，确认完直接显示。经香港转到法国的
 * 每个请求都要一趟往返（约 0.2 秒），等确认完再发就白白多等一轮。没登录的话这些读取也是 401，照样跳登录页。
 */
function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.data || me.isPending) {
    return (
      <>
        {/* 同一个包裹层一直在：确认完只是变可见，页面不重挂 */}
        <div className={cn('contents', me.isPending && 'invisible')}>{children}</div>
        {me.isPending ? (
          <div className="fixed inset-0 z-50">
            <Screen>正在确认登录…</Screen>
          </div>
        ) : null}
      </>
    );
  }
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

/** 跳到正文的落点。tabindex=-1：脚本能聚焦，但不进平时的 Tab 序列。 */
const CONTENT_ID = 'main-content';

function skipToContent(event: { preventDefault(): void }) {
  const main = document.getElementById(CONTENT_ID);
  if (!(main instanceof HTMLElement)) return;
  event.preventDefault();
  main.focus();
}

function Frame() {
  const location = useLocation();
  // 侧栏收不收：人手动选过就按人选的；没选过按屏宽，≥1280 展开、768–1279 收成图标栏
  const [picked, setPicked] = useLocalState<boolean | null>(`${brand.storagePrefix}sidebar-collapsed`, null);
  const navRoom = useNavRoom();
  const collapsed = picked ?? !navRoom;
  const phone = usePhone();
  const [mobileNav, setMobileNav] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  // 推送等确认登录之后再连：连上时的全量重拉不和首屏的读取挤在一起，没登录也不去连
  const { data: me } = useMe();
  useLiveSync(Boolean(me));
  useNoticeToasts();

  // 看板多机：选了远程环境（?node=）时，只有主页和法国页读得到它的快照；别的页读的全是本台的库，整页明说、不渲染（也就不去读）
  const { nodeId } = useNodeSelection();
  const onlyLocal = nodeId !== null && !isRemotePage(location.pathname);

  return (
    <>
      {/* 正文区之前的第一个可聚焦元素。平时不占版面，键盘聚焦才显示。 */}
      <a href={`#${CONTENT_ID}`} className="skip-to-content" onClick={skipToContent}>
        跳到正文
      </a>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {phone ? null : (
            <aside
              className={cn(
                'shrink-0 border-r bg-panel transition-[width] duration-200',
                collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
              )}
            >
              <SidebarNav collapsed={collapsed} onToggle={() => setPicked(!collapsed)} />
            </aside>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar onSearch={() => setCmdk(true)} />
            {/* min-w-0 + overflow-x-hidden：任何一页的内容比正文区宽，都只在自己里面处理，不把整页撑出横向滚动（点验 audit.md，390/768 宽主页被切） */}
            <main
              id={CONTENT_ID}
              tabIndex={-1}
              className="skip-target relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto scrollbar-thin"
              onMouseDown={(event) => {
                // 点空白不该把焦点抢走：只有「跳到正文」才聚焦正文区本身。
                if (event.target === event.currentTarget) event.preventDefault();
              }}
            >
              {onlyLocal ? <OnlyLocalNotice /> : <Outlet />}
            </main>
          </div>
        </div>
        {phone ? <BottomNav onMore={() => setMobileNav(true)} /> : null}
        <Sheet open={mobileNav && phone} onOpenChange={setMobileNav}>
          <SheetContent side="left" className="w-sidebar-sheet bg-panel p-0">
            <SheetTitle className="sr-only">导航</SheetTitle>
            <SheetDescription className="sr-only">{brand.product}的全部页面</SheetDescription>
            <SidebarNav onNavigate={() => setMobileNav(false)} />
          </SheetContent>
        </Sheet>
        <CommandMenu open={cmdk} onOpenChange={setCmdk} />
      </div>
    </>
  );
}

export default function Shell() {
  return (
    <AuthGate>
      <RepoProvider>
        <TaskActionsProvider>
          <TopbarSlotProvider>
            <Frame />
          </TopbarSlotProvider>
        </TaskActionsProvider>
      </RepoProvider>
    </AuthGate>
  );
}
