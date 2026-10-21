import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellRing,
  Check,
  ChevronsUpDown,
  LogOut,
  MoreHorizontal,
  Search,
  ServerCog,
  Settings,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
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
import { EngineMasterBadge } from '../engine-master';
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
import { Kbd } from '../ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { RepoSwitcher } from './repo-switcher';
import { TopbarSlot } from './topbar-slot';

export function Topbar({ onSearch }: { onSearch(): void }) {
  // 选了远程环境：提醒铃铛是本台（法国）的数据，不顶着远程环境的名字露出来
  const { nodeId } = useNodeSelection();
  const phone = usePhone();
  if (phone) {
    // 手机（<768）顶栏只留最要紧的：仓名（挤不下就截断）、总开关点、铃铛、账号；搜索、环境切换、实时状态收进一个「更多」菜单。
    // 原来整排放不下（390 宽内容 438 宽，右缘铃铛被截、头像在屏外，320 宽更糟）。
    return (
      <header
        data-topbar="phone"
        className="flex h-topbar shrink-0 items-center gap-1 overflow-hidden border-b bg-panel px-2"
      >
        <div className="flex min-w-0 flex-1 items-center">
          <RepoSwitcher />
        </div>
        <EngineMasterBadge />
        <MoreMenu onSearch={onSearch} />
        {nodeId === null ? <NotificationBell /> : null}
        <UserMenu />
      </header>
    );
  }
  return (
    <header className="flex h-topbar shrink-0 items-center gap-2 border-b bg-panel px-3 md:px-4">
      <RepoSwitcher />
      <EnvSwitcher />
      <EngineMasterBadge />
      <button
        type="button"
        onClick={onSearch}
        className="ml-1 hidden h-8 w-full max-w-search items-center gap-2 rounded-lg border bg-background px-2.5 text-body text-muted-foreground transition-colors hover:border-border-strong 2xl:flex"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 text-left">搜任务、页面、操作…</span>
        <Kbd>⌘K</Kbd>
      </button>
      {/* 页面（主页）放进顶栏的状态条和刷新条；没页面用时是空的 */}
      <TopbarSlot />
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="size-10 md:size-8 2xl:hidden"
          onClick={onSearch}
          aria-label="搜索"
        >
          <Search />
        </Button>
        <LiveIndicator />
        {nodeId === null ? <NotificationBell /> : null}
        <UserMenu />
      </div>
    </header>
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
      <DropdownMenuLabel className="text-meta text-muted-foreground">
        切换环境（看板按环境显示）
      </DropdownMenuLabel>
      <DropdownMenuItem data-node-item="local" onSelect={() => select(null)}>
        <span className="num min-w-0 flex-1 truncate">{env.name}</span>
        <span className="text-meta text-muted-foreground">这台</span>
        {nodeId === null ? <Check className="size-4" /> : null}
      </DropdownMenuItem>
      {nodesError ? (
        <DropdownMenuItem disabled className="text-meta text-ink-fail">
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
            className={f === 'fresh' ? undefined : 'text-muted-foreground'}
          >
            <span className="num min-w-0 flex-1 truncate">{n.name}</span>
            <span className={cn('text-meta', f === 'fresh' ? 'text-muted-foreground' : 'text-ink-stall')}>
              {nodeAgeText(n, now)}
            </span>
            {n.id === nodeId ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => navigate(withNode('/france', nodeId))}>
        <ServerCog />
        打开法国页
      </DropdownMenuItem>
      {problem ? (
        <DropdownMenuItem disabled className="text-meta text-ink-stall">
          {env.problem}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/**
 * 手机顶栏的「更多」：搜索、环境切换、实时状态三样收在这里。
 * 实时断了或环境失联/有问题时，按钮角上亮一个等待色点，不用点开也知道该看一眼。
 */
function MoreMenu({ onSearch }: { onSearch(): void }) {
  const { status } = useLiveState();
  const env = useEnvView();
  const liveOk = status === 'open';
  const attention = !liveOk || (env !== null && (env.problem || env.state !== 'fresh'));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="relative size-10 shrink-0"
          aria-label={attention ? '搜索、环境、实时（有状态要看一眼）' : '搜索、环境、实时'}
          data-topbar-more={attention ? 'attention' : 'ok'}
        >
          <MoreHorizontal />
          {attention ? (
            <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-st-stall" />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={onSearch}>
          <Search />
          搜任务、页面、操作
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <EnvMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled data-live={status} className={liveOk ? undefined : 'text-ink-stall'}>
          <span
            className={cn(
              'size-1.5 rounded-full',
              liveOk ? 'bg-st-done' : status === 'down' ? 'bg-st-fail' : 'bg-st-stall',
            )}
          />
          {liveOk ? '实时：连着' : status === 'down' ? '实时：推送断了，正在重连' : '实时：连接中'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 顶栏环境切换器（看板多机；替掉原来没用的「切换仓」、合并原来的环境名徽标 #820 片 1）：常驻「现在看的是哪一台」，
 * 点开列出本台和每个远程环境（本机 WSL）、各自上报于几分钟前或失联多久，选哪个就把它记在网址参数 ?node=（留在当前这一页）。
 * 本台的名字跟着 /me 带回（后端的 FLEET_MACHINE_NAME），读不到就照实写「认不出」，不猜成某一台；远程环境的列表读不成就在
 * 下拉里写原因，不当成「没有远程环境」。
 */
function EnvSwitcher() {
  const view = useEnvView();
  if (!view) return null;
  const { nodeId, label, state, problem } = view;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          data-env-switcher={nodeId ?? 'local'}
          className={cn(
            'h-10 shrink-0 gap-1.5 px-2 text-body md:h-8',
            problem || state !== 'fresh' ? 'text-ink-stall' : undefined,
          )}
          aria-label={`现在看的是${label}，点开切换环境`}
        >
          <ServerCog className="size-3.5 opacity-70" aria-hidden />
          <span className="num max-w-24 truncate font-semibold md:max-w-32">{label}</span>
          {nodeId !== null ? (
            <span
              className={cn(
                'rounded-sm border px-1.5 text-meta whitespace-nowrap',
                state === 'fresh' ? 'text-muted-foreground' : 'border-st-stall-line text-ink-stall',
              )}
            >
              {state === 'fresh' ? '只读' : state === 'stale' ? '失联' : '没数据'}
            </span>
          ) : null}
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <EnvMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 「实时」小灯：连着时是绿的、每收到一次推送闪一下；重连时变黄，被后端关掉（等着退避重连）时变红。
 * 手机上也要看得见，点后面一直带字。
 */
function LiveIndicator() {
  const { status, lastEventAt } = useLiveState();
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!lastEventAt) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 700);
    return () => clearTimeout(t);
  }, [lastEventAt]);
  const ok = status === 'open';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          data-live={status}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-meta whitespace-nowrap md:px-2',
            ok ? 'text-muted-foreground' : status === 'down' ? 'text-ink-fail' : 'text-ink-stall',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full transition-[box-shadow,transform] duration-300',
              ok ? 'bg-st-done' : status === 'down' ? 'bg-st-fail' : 'bg-st-stall',
              flash && 'scale-125 shadow-done-pop',
            )}
          />
          {/* 手机上也写字：光一个绿点不知道指什么（#1899） */}
          <span>{ok ? '实时' : status === 'down' ? '推送断了' : '连接中'}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {ok
          ? '实时推送连着：盘面有变化会自己刷新'
          : status === 'down'
            ? '推送被后端断开了，正在自动重连（间隔逐步拉长到 30 秒）；这段时间页面不会自己刷新，连上后全量重拉一次'
            : '推送在重连；连上后会全量重拉一次'}
      </TooltipContent>
    </Tooltip>
  );
}

function NotificationBell() {
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
    if (n.link) navigate(n.link);
    else navigate('/notifications');
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="relative size-10 md:size-8"
          aria-label={error && !data ? '提醒没读成' : `提醒，${urgent} 条待处理`}
        >
          {urgent ? <BellRing /> : <Bell />}
          {error && !data ? (
            <span className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-destructive text-meta font-semibold text-destructive-foreground">
              !
            </span>
          ) : urgent ? (
            <span className="num absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-st-human px-1 text-meta font-semibold text-background">
              {urgent}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-notifications p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-body font-semibold">待处理的提醒</span>
          <span className="num text-meta text-muted-foreground">
            {data ? urgent : '—'}
            {daily > 0 ? `，另有日报 ${daily}` : ''}
          </span>
        </div>
        {error && !data ? (
          <p role="alert" className="px-3 py-6 text-center text-body text-ink-fail">
            提醒没读成：{errorText(error)}
          </p>
        ) : data && urgent + daily === 0 ? (
          <p className="px-3 py-6 text-center text-body text-muted-foreground">没有待处理的提醒</p>
        ) : null}
        <ul className="max-h-notifications-list overflow-y-auto scrollbar-thin">
          {items.slice(0, 8).map((n) => (
            <li key={n.id} className="flex items-start gap-1 border-b pr-2 last:border-b-0">
              <button
                type="button"
                onClick={() => go(n)}
                className="flex min-w-0 flex-1 gap-2.5 px-3 py-2.5 text-left hover:bg-accent"
              >
                <StatusDot tone={noticeLevelMeta[n.level].tone} className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium">{n.title}</span>
                  <span className="block truncate text-meta text-muted-foreground">{n.body}</span>
                </span>
                <span className="num shrink-0 text-meta text-muted-foreground">
                  {formatAgo(n.createdAt, now)}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 h-7 shrink-0 px-2 text-meta text-muted-foreground"
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
          className="block border-t px-3 py-2 text-center text-meta text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          打开通知中心
        </Link>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu() {
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
        <Button variant="ghost" className="size-10 rounded-full p-0 md:size-8" aria-label="我的账号">
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="size-7 rounded-full object-cover" />
          ) : (
            <span className="grid size-7 place-items-center rounded-full bg-foreground text-meta font-semibold text-background">
              {user ? nameInitial(user.displayName) : '·'}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>
          <div className="text-body">{user?.displayName}</div>
          <div className="text-meta font-normal text-muted-foreground">创始人</div>
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
