import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import { ApiError, errorText, useLiveSync, useMe, useNotifications } from '../api/client';
import { loginPath } from '../api/index';
import { GatewayHealthLink } from '../components/gateway-health-link';
import { isRemotePage, OnlyLocalNotice } from '../components/node-notice';
import { RepoProvider } from '../components/repo-context';
import { CommandMenu } from '../components/shell/command-menu';
import { AppFrame, ShellScreen } from '../components/shell/frame';
import { TopbarSlotProvider } from '../components/shell/topbar-slot';
import { TaskActionsProvider } from '../components/task-actions';
import { Button } from '../components/ui/button';
import { useLocalState, useMediaQuery } from '../lib/hooks';
import { useNodeSelection } from '../lib/node';
import { useAppBadge, useBadgeCount } from '../lib/pwa/hooks';
import { showSystemNotification } from '../lib/pwa/notify';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';

/**
 * 没登录就不进外壳：401 时 API 层已经在跳登录页，这里只负责别把半截页面露出来。
 * 确认登录的同时外壳和页面已经挂上（看不见）：它们的读取和 /api/me 一起发出去，确认完直接显示。经香港转到法国的
 * 每个请求都要一趟往返（约 0.2 秒），等确认完再发就白白多等一轮。没登录的话这些读取也是 401，照样跳登录页。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.data || me.isPending) {
    return (
      <>
        {/* 同一个包裹层一直在：确认完只是变可见，页面不重挂 */}
        <div className={cn('contents', me.isPending && 'invisible')}>{children}</div>
        {me.isPending ? (
          <div className="fixed inset-0 z-50">
            <ShellScreen>正在确认登录…</ShellScreen>
          </div>
        ) : null}
      </>
    );
  }
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  return (
    <ShellScreen
      title={unauthenticated ? '要先登录，正在跳到登录页…' : '没能确认登录'}
      actions={
        <>
          {unauthenticated ? null : (
            <Button size="sm" variant="outline" onClick={() => void me.refetch()}>
              重试
            </Button>
          )}
          <Button asChild size="sm">
            <Link to={loginPath()}>去登录页</Link>
          </Button>
        </>
      }
    >
      {unauthenticated ? null : <p>{errorText(me.error)}</p>}
      {unauthenticated ? null : <GatewayHealthLink error={me.error} />}
    </ShellScreen>
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
      // 窗口不在前台（APP 开着但切走了）时再弹一条系统通知；在前台只有上面的 toast。没授权、不支持都是不弹
      showSystemNotification(n, navigate);
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
  // 左菜单收不收：人手动选过就按人选的（记在浏览器本地）；没选过按屏宽，≥1280 展开 220、768–1279 收成 48 宽的图标条（#3509，照 Arco Pro）
  const [picked, setPicked] = useLocalState<boolean | null>(`${brand.storagePrefix}sidebar-collapsed`, null);
  const menuRoom = useMediaQuery('(min-width: 1280px)');
  const collapsed = picked ?? !menuRoom;
  const phone = usePhone();
  const [cmdk, setCmdk] = useState(false);
  // 推送等确认登录之后再连：连上时的全量重拉不和首屏的读取挤在一起，没登录也不去连
  const { data: me } = useMe();
  useLiveSync(Boolean(me));
  useNoticeToasts();
  useAppBadge(useBadgeCount());

  // 看板多机：选了远程环境（?node=）时，只有工作台、画布、法国页和资源页读得到它的快照；别的页读的全是本台的库，整页明说、不渲染（也就不去读）
  const { nodeId } = useNodeSelection();
  const onlyLocal = nodeId !== null && !isRemotePage(location.pathname);

  return (
    <>
      {/* 正文区之前的第一个可聚焦元素。平时不占版面，键盘聚焦才显示。 */}
      <a href={`#${CONTENT_ID}`} className="skip-to-content" onClick={skipToContent}>
        跳到正文
      </a>
      {/* 照 Arco Pro：顶栏 60 横跨全宽，下面左菜单 + 内容区（版式在 components/shell/frame.tsx） */}
      <AppFrame
        phone={phone}
        collapsed={collapsed}
        onToggleMenu={() => setPicked(!collapsed)}
        onSearch={() => setCmdk(true)}
        contentId={CONTENT_ID}
      >
        {onlyLocal ? <OnlyLocalNotice /> : <Outlet />}
      </AppFrame>
      {/* ⌘K 始终可用：远程环境、只在本台有的页上也能开 */}
      <CommandMenu open={cmdk} onOpenChange={setCmdk} />
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
