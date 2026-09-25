import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellRing,
  Check,
  ChevronsUpDown,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Search,
  Settings,
  Sun,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  errorText,
  useAllBoards,
  useApi,
  useLiveState,
  useMe,
  useNotifications,
  useResolveNotification,
} from '../../api/client';
import type { Notification } from '../../api/types';
import { formatAgo } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { noticeLevelMeta, taskTone } from '../../lib/status';
import { type ModePref, PALETTES } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { useRepo } from '../repo-context';
import { StatusDot } from '../status';
import { useTheme } from '../theme-provider';
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
import { PaletteSwatch } from './palette-swatch';

export function Topbar({ onMenu, onSearch }: { onMenu(): void; onSearch(): void }) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b bg-panel/80 px-3 backdrop-blur md:px-4">
      <Button size="icon" variant="ghost" className="size-8 md:hidden" onClick={onMenu} aria-label="打开导航">
        <Menu />
      </Button>
      <RepoSwitcher />
      <button
        type="button"
        onClick={onSearch}
        className="ml-1 hidden h-8 w-full max-w-[380px] items-center gap-2 rounded-lg border bg-background/60 px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-border-strong sm:flex"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 text-left">搜任务、页面、操作…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <div className="ml-auto flex items-center gap-1">
        <Button size="icon" variant="ghost" className="size-8 sm:hidden" onClick={onSearch} aria-label="搜索">
          <Search />
        </Button>
        <LiveIndicator />
        <NotificationBell />
        <ThemeMenu />
        <UserMenu />
      </div>
    </header>
  );
}

function RepoSwitcher() {
  const { repo, repos, setRepoId, error: reposError } = useRepo();
  const { boards, failed } = useAllBoards();
  const navigate = useNavigate();
  const countFor = (repoId: string) => {
    const list = boards.find((b) => b.repo.id === repoId)?.tasks ?? [];
    return {
      run: list.filter((t) => taskTone(t) === 'run').length,
      stuck: list.filter((t) => ['stall', 'fail', 'human'].includes(taskTone(t))).length,
    };
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 gap-1.5 px-2 text-[13px]" aria-label="切换仓">
          <span className="num hidden text-muted-foreground lg:inline">{repo?.owner}/</span>
          {repo ? (
            <span className="num max-w-40 truncate font-semibold">{repo.name}</span>
          ) : reposError ? (
            <span className="text-ink-fail">仓列表没读成</span>
          ) : (
            <span className="num font-semibold">…</span>
          )}
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          切换仓（看板按仓显示）
        </DropdownMenuLabel>
        {reposError ? (
          <DropdownMenuItem disabled className="text-xs text-ink-fail">
            仓列表没读成{repos.length ? '，下面是上次读到的' : ''}：{errorText(reposError)}
          </DropdownMenuItem>
        ) : null}
        {repos.map((r) => {
          const c = countFor(r.id);
          return (
            <DropdownMenuItem
              key={r.id}
              onSelect={() => {
                setRepoId(r.id);
                navigate('/');
              }}
            >
              <span className="num min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">{r.owner}/</span>
                {r.name}
              </span>
              {failed.some((f) => f.id === r.id) ? (
                <span className="text-xs text-ink-fail">没读成</span>
              ) : null}
              {c.run ? (
                <span className="num flex items-center gap-1 text-xs text-muted-foreground">
                  <StatusDot tone="run" className="size-1.5" />
                  {c.run}
                </span>
              ) : null}
              {c.stuck ? (
                <span className="num flex items-center gap-1 text-xs text-ink-stall">
                  <TriangleAlert className="size-3" />
                  {c.stuck}
                </span>
              ) : null}
              {r.id === repo?.id ? <Check className="size-4" /> : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/overview')}>
          <LayoutDashboard />
          全部仓 · 总览
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 「实时」小灯：连着时是绿的、每收到一次推送闪一下；重连时变黄，被后端关掉（等着退避重连）时变红。
 * 手机上也要看得见：连着时只留一个点，断了连字一起显示——页面停更时人得知道。
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
            'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-xs whitespace-nowrap md:px-2',
            ok ? 'text-muted-foreground' : status === 'down' ? 'text-ink-fail' : 'text-ink-stall',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full transition-[box-shadow,transform] duration-300',
              ok ? 'bg-st-done' : status === 'down' ? 'bg-st-fail' : 'bg-st-stall',
              flash && 'scale-125 shadow-[0_0_0_4px_color-mix(in_oklab,var(--st-done)_30%,transparent)]',
            )}
          />
          <span className={cn(ok && 'sr-only md:not-sr-only')}>
            {ok ? '实时' : status === 'down' ? '推送断了' : '连接中'}
          </span>
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
  const urgent = items.filter((n) => n.level !== 'daily').length;
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
          className="relative size-8"
          aria-label={error && !data ? '提醒没读成' : `提醒，${urgent} 条待处理`}
        >
          {urgent ? <BellRing /> : <Bell />}
          {error && !data ? (
            <span className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-st-fail text-[10px] leading-4 font-bold text-white">
              !
            </span>
          ) : urgent ? (
            <span className="num absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-st-human px-1 text-[10px] leading-4 font-semibold text-white">
              {urgent}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">待处理的提醒</span>
          <span className="num text-xs text-muted-foreground">{data ? items.length : '—'}</span>
        </div>
        {error && !data ? (
          <p role="alert" className="px-3 py-6 text-center text-sm text-ink-fail">
            提醒没读成：{errorText(error)}
          </p>
        ) : data && items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">没有待处理的提醒</p>
        ) : null}
        <ul className="max-h-[360px] overflow-y-auto scrollbar-thin">
          {items.slice(0, 8).map((n) => (
            <li key={n.id} className="flex items-start gap-1 border-b pr-2 last:border-b-0">
              <button
                type="button"
                onClick={() => go(n)}
                className="flex min-w-0 flex-1 gap-2.5 px-3 py-2.5 text-left hover:bg-accent"
              >
                <StatusDot tone={noticeLevelMeta[n.level].tone} className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{n.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{n.body}</span>
                </span>
                <span className="num shrink-0 text-[11px] text-muted-foreground">
                  {formatAgo(n.createdAt, now)}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 h-7 shrink-0 px-2 text-xs text-muted-foreground"
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
          className="block border-t px-3 py-2 text-center text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          打开通知中心
        </Link>
      </PopoverContent>
    </Popover>
  );
}

const MODES: { id: ModePref; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor },
];

export function ModeSwitch() {
  const { pref, setMode } = useTheme();
  return (
    <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="深浅">
      {MODES.map((m) => {
        const Icon = m.icon;
        const active = pref.mode === m.id;
        return (
          // biome-ignore lint/a11y/useSemanticElements: 分段按钮组，按钮比单选框更好点。
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setMode(m.id)}
            className={cn(
              'flex h-7 items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors',
              active ? 'bg-card font-medium text-foreground shadow-sm' : 'hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function ThemeMenu() {
  const { pref, resolvedMode, setPalette } = useTheme();
  const Icon = resolvedMode === 'dark' ? Moon : Sun;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8" aria-label="主题">
              <Icon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>主题色与深浅</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[340px]">
        <div className="mb-2 text-xs text-muted-foreground">深浅</div>
        <ModeSwitch />
        <div className="mt-4 mb-2 text-xs text-muted-foreground">主题色</div>
        <div className="grid grid-cols-2 gap-2">
          {PALETTES.map((p) => (
            <PaletteSwatch
              key={p.id}
              id={p.id}
              mode={resolvedMode}
              active={pref.palette === p.id}
              onPick={setPalette}
            />
          ))}
        </div>
        <Link
          to="/settings"
          className="mt-3 block text-center text-xs text-muted-foreground hover:text-foreground"
        >
          更多外观设置
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
      await api.logout();
      qc.clear();
      navigate('/login', { replace: true });
    } catch (e) {
      toast.error('退出没成功', { description: errorText(e) });
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="size-8 rounded-full p-0" aria-label="我的账号">
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="size-7 rounded-full object-cover" />
          ) : (
            <span className="grid size-7 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
              {user?.displayName.slice(0, 1) ?? '·'}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>
          <div className="text-sm">{user?.displayName}</div>
          <div className="text-xs font-normal text-muted-foreground">创始人 · 飞书登录</div>
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
