// 顶栏（#3509，照 Main.dc.html 的 .nav-top）：60 高、横跨全宽、白底。
// 左边：标志「驾驶舱」、竖分隔、仓切换、环境切换、搜索框（点开是 ⌘K 面板）；页面放进顶栏的插槽（TopbarSlot）在中间；
// 右边：实时推送（连着时不占地方，断了才露出来）、引擎状态（点 + 字）、铃铛（通知计数）、帮助、头像（账号菜单）。
// 手机（<768，Phone.dc.html）：只留标志、仓名、总开关点、「更多」（搜索、环境、实时）、铃铛、账号，每个按钮 40×40。
// 选了远程环境：铃铛不露（提醒是本台的数据），总开关只读。
import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Database,
  LogOut,
  MoreHorizontal,
  Navigation,
  ScrollText,
  Search,
  Server,
  Settings,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import {
  errorText,
  logoutAndClear,
  useApi,
  useLiveState,
  useMe,
  useNodes,
  useNotifications,
  useResolveNotification,
} from '../../api/client';
import type { Notification } from '../../api/types';
import { formatAgo, nameInitial } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { freshnessNow, nodeAgeText, useNodeSelection, withNode } from '../../lib/node';
import { pendingCount } from '../../lib/notice-count';
import { noticeLevelMeta } from '../../lib/status';
import { cn } from '../../lib/utils';
import { usePhone } from '../../lib/viewport';
import { StatusDot } from '../layout/status-badge';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { EngineStatus, StatusPoint } from './engine-status';
import { RepoSwitcher } from './repo-switcher';
import { CountBadge } from './sidebar';
import { TopbarSlot } from './topbar-slot';

/** 顶栏右边的圆按钮（.nav-btn）：电脑 32，手机 40（拇指够得着）。 */
const navBtn = (phone: boolean) =>
  cn(
    'relative grid shrink-0 place-items-center rounded-full border border-line text-ink-2 transition-colors duration-100 hover:bg-fill-2 hover:text-ink',
    phone ? 'size-10' : 'size-8',
  );

/** 标志：蓝底方块（.logo-mark）。 */
export function ShellMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('grid size-7 shrink-0 place-items-center rounded-md bg-brand text-on-brand', className)}
    >
      <Navigation className="size-4" />
    </span>
  );
}

export function Topbar({ onSearch }: { onSearch(): void }) {
  // 选了远程环境：提醒铃铛是本台（法国）的数据，不顶着远程环境的名字露出来
  const { nodeId } = useNodeSelection();
  const phone = usePhone();
  if (phone) {
    return (
      <header
        data-topbar="phone"
        className="flex h-topbar shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-card px-3"
      >
        <span role="img" aria-label={brand.product} className="shrink-0">
          <ShellMark />
        </span>
        <div className="flex min-w-0 flex-1 items-center">
          <RepoSwitcher phone />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <EngineStatus compact />
          <MoreMenu onSearch={onSearch} />
          {nodeId === null ? <NotificationBell phone /> : null}
          <UserMenu phone />
        </div>
      </header>
    );
  }
  return (
    <header className="flex h-topbar shrink-0 items-center gap-4 border-b border-line bg-card px-5">
      <Link
        to={withNode('/', nodeId)}
        className="flex shrink-0 items-center gap-2.5 text-heading font-semibold whitespace-nowrap text-ink hover:text-ink"
      >
        <ShellMark />
        <span className="hidden lg:inline">{brand.product}</span>
      </Link>
      <MockTag />
      <span aria-hidden className="h-4 w-px shrink-0 bg-line" />
      <div className="flex min-w-0 items-center gap-1">
        <RepoSwitcher />
        <EnvSwitcher />
      </div>
      <button
        type="button"
        onClick={onSearch}
        aria-label="搜索"
        title="搜索任务、页面（⌘K）"
        className="flex h-8 shrink-0 items-center gap-2 rounded-full bg-fill-2 text-body text-ink-3 transition-colors duration-100 hover:bg-fill-3 max-lg:w-8 max-lg:justify-center lg:w-60 lg:px-3"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="hidden truncate lg:inline">搜索任务、页面</span>
      </button>
      {/* 页面（主页）放进顶栏的状态条和刷新条；没页面用时是空的 */}
      <TopbarSlot />
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <LiveIndicator />
        <EngineStatus />
        {nodeId === null ? <NotificationBell /> : null}
        <HelpMenu onSearch={onSearch} />
        <UserMenu />
      </div>
    </header>
  );
}

/** 假数据模式：标志旁一个灰标签，免得把编的数当真的。 */
function MockTag() {
  const api = useApi();
  if (api.source === 'http') return null;
  return (
    <span
      title="现在显示的是编的假数据，会自己「动」起来；页面上的操作只改这份假数据。"
      className="inline-flex h-6 shrink-0 items-center rounded-sm bg-fill-2 px-2 text-meta whitespace-nowrap text-ink-2 max-md:hidden"
    >
      假数据
    </span>
  );
}

/** 环境切换器和手机「更多」菜单共用的读法：现在看的是哪一台、它新不新鲜、本台有没有问题。 */
function useEnvView() {
  const { data: me } = useMe();
  const nodes = useNodes();
  const { nodeId, select } = useNodeSelection();
  const now = useNow();
  if (!me) return null;
  const { env } = me;
  const remote = nodes.data?.nodes ?? [];
  const selected = nodeId === null ? undefined : remote.find((n) => n.id === nodeId);
  const label = nodeId === null ? env.name : (selected?.name ?? nodeId);
  const state = nodeId === null ? 'fresh' : freshnessNow(selected ?? {}, now);
  const problem = nodeId === null && env.problem !== undefined;
  return { env, remote, nodeId, select, now, nodesError: nodes.error, label, state, problem };
}

/** 环境下拉里的列表本体（本台、各远程环境、打开法国页、本台的问题）；电脑的环境切换器和手机的「更多」菜单都用它。 */
function EnvMenuItems() {
  const view = useEnvView();
  const navigate = useNavigate();
  if (!view) return null;
  const { env, remote, nodeId, select, now, nodesError, problem } = view;
  return (
    <>
      <DropdownMenuLabel className="text-meta font-normal text-ink-3">
        切换环境（看板按环境显示）
      </DropdownMenuLabel>
      <DropdownMenuItem data-node-item="local" onSelect={() => select(null)}>
        <span className="num min-w-0 flex-1 truncate">{env.name}</span>
        <span className="text-meta text-ink-3">这台</span>
        {nodeId === null ? <Check className="size-4 text-brand-ink" /> : null}
      </DropdownMenuItem>
      {nodesError ? (
        <DropdownMenuItem disabled className="text-meta text-fail-ink">
          远程环境没读成：{errorText(nodesError)}
        </DropdownMenuItem>
      ) : null}
      {remote.map((n) => {
        const f = freshnessNow(n, now);
        return (
          <DropdownMenuItem
            key={n.id}
            data-node-item={n.id}
            data-node-state={f}
            onSelect={() => select(n.id)}
            className={f === 'fresh' ? undefined : 'text-ink-3'}
          >
            <span className="num min-w-0 flex-1 truncate">{n.name}</span>
            <span className={cn('text-meta', f === 'fresh' ? 'text-ink-3' : 'text-warn-ink')}>
              {nodeAgeText(n, now)}
            </span>
            {n.id === nodeId ? <Check className="size-4 text-brand-ink" /> : null}
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => navigate(withNode('/france', nodeId))}>
        <Server />
        打开法国页
      </DropdownMenuItem>
      {problem ? (
        <DropdownMenuItem disabled className="text-meta text-warn-ink">
          {env.problem}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/**
 * 手机顶栏的「更多」：搜索、环境切换、实时状态三样收在这里。
 * 实时断了或环境失联/有问题时，按钮角上亮一个橙点，不用点开也知道该看一眼。
 */
function MoreMenu({ onSearch }: { onSearch(): void }) {
  const { status } = useLiveState();
  const env = useEnvView();
  const liveOk = status === 'open';
  const attention = !liveOk || (env !== null && (env.problem || env.state !== 'fresh'));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={navBtn(true)}
          aria-label={attention ? '搜索、环境、实时（有状态要看一眼）' : '搜索、环境、实时'}
          data-topbar-more={attention ? 'attention' : 'ok'}
        >
          <MoreHorizontal className="size-4" aria-hidden />
          {attention ? <StatusPoint dot="warning" className="absolute top-0 right-0 size-2" /> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={onSearch}>
          <Search />
          搜任务、页面、操作
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <EnvMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled data-live={status} className={liveOk ? undefined : 'text-warn-ink'}>
          <StatusPoint dot={liveOk ? 'success' : 'warning'} />
          {liveOk ? '实时：连着' : status === 'down' ? '实时：推送断了，正在重连' : '实时：连接中'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 顶栏环境切换器（看板多机）：常驻「现在看的是哪一台」，写成「环境 法国 本台」；远程时写那台的名字和「只读 / 失联 / 没数据」。
 * 点开列出本台和每个远程环境（本机 WSL）、各自上报于几分钟前或失联多久，选哪个就把它记在网址参数 ?node=（留在当前这一页）。
 * 本台的名字跟着 /me 带回（后端的 FLEET_MACHINE_NAME），读不到就照实写「认不出」，不猜成某一台；远程环境的列表读不成就在
 * 下拉里写原因，不当成「没有远程环境」。
 */
function EnvSwitcher() {
  const view = useEnvView();
  if (!view) return null;
  const { nodeId, label, state, problem } = view;
  const warn = problem || state !== 'fresh';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-env-switcher={nodeId ?? 'local'}
          aria-label={`现在看的是${label}，点开切换环境`}
          className="flex h-8 min-w-0 shrink items-center gap-1.5 rounded-sm px-2.5 text-body whitespace-nowrap text-ink transition-colors duration-100 hover:bg-fill-2"
        >
          <span className="hidden text-ink-3 xl:inline">环境</span>
          <span className="num min-w-0 truncate">{label}</span>
          {nodeId === null ? (
            <span className="text-ink-3">本台</span>
          ) : (
            <span
              className={cn(
                'inline-flex h-5 items-center rounded-sm px-1.5 text-meta',
                state === 'fresh' ? 'bg-fill-2 text-ink-2' : 'bg-warn-1 text-warn-ink',
              )}
            >
              {state === 'fresh' ? '只读' : state === 'stale' ? '失联' : '没数据'}
            </span>
          )}
          {problem ? <StatusPoint dot="warning" /> : null}
          <ChevronDown className={cn('size-4 shrink-0', warn ? 'text-warn-ink' : 'text-ink-3')} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <EnvMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 实时推送：连着时不占顶栏（只给读屏一句），颜色只给异常——重连时橙点「连接中」，被后端断开（等着退避重连）时红点「推送断了」。
 * 每收到一次推送，读屏那句不变，不闪。
 */
function LiveIndicator() {
  const { status } = useLiveState();
  const ok = status === 'open';
  if (ok) {
    return (
      <span role="status" data-live={status} className="sr-only">
        实时推送连着
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          data-live={status}
          className={cn(
            'flex h-8 shrink-0 items-center gap-2 text-body whitespace-nowrap',
            status === 'down' ? 'text-fail-ink' : 'text-warn-ink',
          )}
        >
          <span
            aria-hidden
            className={cn('size-1.5 rounded-full', status === 'down' ? 'bg-fail' : 'bg-warn')}
          />
          {status === 'down' ? '推送断了' : '连接中'}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        {status === 'down'
          ? '推送被后端断开了，正在自动重连（间隔逐步拉长到 30 秒）；这段时间页面不会自己刷新，连上后全量重拉一次'
          : '推送在重连；连上后会全量重拉一次'}
      </TooltipContent>
    </Tooltip>
  );
}

function NotificationBell({ phone = false }: { phone?: boolean }) {
  const { data, error } = useNotifications('open');
  const resolve = useResolveNotification();
  const navigate = useNavigate();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const items = data?.items ?? [];
  const urgent = data ? pendingCount(data.counts) : 0;
  const daily = data?.counts.daily ?? 0;
  const go = (n: Notification) => {
    setOpen(false);
    navigate(n.link ?? '/notifications');
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={navBtn(phone)}
          aria-label={error && !data ? '提醒没读成' : `提醒，${urgent} 条待处理`}
        >
          <Bell className="size-4" aria-hidden />
          <CountBadge
            value={error && !data ? '!' : urgent}
            className="absolute -top-1.5 left-4 h-4.5 min-w-4.5 px-1 ring-2 ring-card"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-notifications p-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-heading text-ink">待处理的提醒</span>
          <span className="num text-meta text-ink-3">
            {data ? urgent : '—'}
            {daily > 0 ? `，另有日报 ${daily}` : ''}
          </span>
        </div>
        {error && !data ? (
          <p role="alert" className="px-4 py-6 text-center text-body text-fail-ink">
            提醒没读成：{errorText(error)}
          </p>
        ) : data && urgent + daily === 0 ? (
          <p className="px-4 py-6 text-center text-body text-ink-3">没有待处理的提醒</p>
        ) : null}
        <ul className="max-h-notifications-list overflow-y-auto scrollbar-thin">
          {items.slice(0, 8).map((n) => (
            <li key={n.id} className="flex items-start gap-1 border-b border-line pr-2 last:border-b-0">
              <button
                type="button"
                onClick={() => go(n)}
                className="flex min-w-0 flex-1 gap-2.5 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-fill-1"
              >
                <StatusDot tone={noticeLevelMeta[n.level].tone} className="mt-2" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-ink">{n.title}</span>
                  <span className="block truncate text-meta text-ink-3">{n.body}</span>
                </span>
                <span className="num shrink-0 text-meta text-ink-3">{formatAgo(n.createdAt, now)}</span>
              </button>
              <Button
                size="xs"
                variant="ghost"
                className="mt-2 shrink-0 text-ink-2"
                loading={resolve.isPending}
                disabled={resolve.isPending}
                onClick={() =>
                  resolve.mutate(n.id, {
                    onError: (e) => toast.error('没处理成', { description: errorText(e) }),
                  })
                }
              >
                处理
              </Button>
            </li>
          ))}
        </ul>
        <Link
          to="/notifications"
          onClick={() => setOpen(false)}
          className="block border-t border-line px-4 py-2.5 text-center text-body text-brand-ink hover:text-link-hover"
        >
          打开通知中心
        </Link>
      </PopoverContent>
    </Popover>
  );
}

/** 帮助：⌘K 怎么用、发布记录、数据从哪来（真后端还是假数据）。 */
function HelpMenu({ onSearch }: { onSearch(): void }) {
  const api = useApi();
  const mock = api.source !== 'http';
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={navBtn(false)} aria-label="帮助">
          <CircleHelp className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={onSearch}>
          <Search />
          <span className="flex-1">搜索页面和操作</span>
          <span className="num text-meta text-ink-3">⌘K</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/changelog')}>
          <ScrollText />
          发布记录
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled className="items-start text-meta text-ink-3">
          <Database className="mt-0.5" />
          {mock
            ? '数据：编的假数据（演示），会自己「动」起来；页面上的操作只改这份假数据'
            : `数据来自${brand.product}后端（/api），推送走 /api/events`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ phone = false }: { phone?: boolean }) {
  const { data: me } = useMe();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const user = me?.user;
  const logout = async () => {
    try {
      await logoutAndClear(api, qc);
      navigate('/login', { replace: true });
    } catch (e) {
      toast.error('退出没成功', { description: errorText(e) });
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn('grid shrink-0 place-items-center rounded-full', phone ? 'size-10' : 'size-8')}
          aria-label="我的账号"
        >
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="size-8 rounded-full object-cover" />
          ) : (
            <span className="grid size-8 place-items-center rounded-full bg-brand-1 text-body font-semibold text-brand-ink">
              {user ? nameInitial(user.displayName) : '·'}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="font-normal">
          <div className="text-body font-medium text-ink">{user?.displayName}</div>
          <div className="text-meta text-ink-3">创始人</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings />
          设置
        </DropdownMenuItem>
        <DropdownMenuItem disabled={api.source === 'mock'} onSelect={() => void logout()}>
          <LogOut />
          {api.source === 'mock' ? '退出（假数据模式不用登录）' : '退出登录'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
