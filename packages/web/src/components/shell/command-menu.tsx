import { FolderGit2, Moon, Palette, Sun, TriangleAlert, User } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAllBoards } from '../../api/client';
import { isTaskClosed, taskStateLabel, taskTone } from '../../lib/status';
import { PALETTES } from '../../lib/theme';
import { useRepo } from '../repo-context';
import { StatusChip } from '../status';
import { useTheme } from '../theme-provider';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '../ui/command';
import { NAV_ITEMS } from './nav';

/** ⌘K：跳页面、找需求、改看板过滤、切仓、切主题。 */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const navigate = useNavigate();
  const { boards, failed } = useAllBoards();
  const { repos, setRepoId, error: reposError } = useRepo();
  const theme = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const multiRepo = boards.length > 1;
  const sorted = boards
    .flatMap((b) => b.tasks.map((t) => ({ t, repo: b.repo })))
    .sort((a, b) => Number(isTaskClosed(a.t)) - Number(isTaskClosed(b.t)) || a.t.priority - b.t.priority);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="sm:max-w-xl">
      <CommandInput placeholder="输入页面名、需求编号或标题、操作…" />
      <CommandList className="max-h-[440px]">
        <CommandEmpty>没找到</CommandEmpty>
        <CommandGroup heading="需求">
          {reposError ? (
            // 仓列表没读成：一个仓都不知道，需求自然也搜不到——照实说，不让空列表冒充「没有」。
            <CommandItem disabled forceMount value="仓列表没读成 需求 仓">
              <span className="text-xs text-ink-fail">
                仓列表没读成，这里{repos.length ? '只有上次读到的仓的需求' : '搜不到任何需求'}
              </span>
            </CommandItem>
          ) : null}
          {failed.length ? (
            <CommandItem disabled forceMount value={`没读成 ${failed.map((r) => r.name).join(' ')}`}>
              <span className="text-xs text-ink-fail">
                仓 {failed.map((r) => r.name).join('、')} 的需求没读成，这里搜不到它们
              </span>
            </CommandItem>
          ) : null}
          {sorted.map(({ t, repo }) => (
            <CommandItem
              key={t.id}
              value={`#${t.issueNumber} ${t.title} ${t.requestedBy} ${repo.name}`}
              onSelect={() => run(() => navigate(`/tasks/${t.id}`))}
            >
              <span className="num w-9 shrink-0 text-muted-foreground">#{t.issueNumber}</span>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {multiRepo ? (
                <span className="num shrink-0 text-xs text-muted-foreground">{repo.name}</span>
              ) : null}
              <StatusChip tone={taskTone(t)} label={taskStateLabel[t.state]} />
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="跳转">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.to}
                value={`${item.label} ${item.hint}`}
                onSelect={() => run(() => navigate(item.to))}
              >
                <Icon />
                {item.label}
                <span className="truncate text-xs text-muted-foreground">{item.hint}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="看板">
          <CommandItem value="只看卡住的 停滞 失败 等人" onSelect={() => run(() => navigate('/?stuck=1'))}>
            <TriangleAlert />
            只看卡住的
            <CommandShortcut>S</CommandShortcut>
          </CommandItem>
          <CommandItem value="只看我提的" onSelect={() => run(() => navigate('/?mine=1'))}>
            <User />
            只看我提的
            <CommandShortcut>I</CommandShortcut>
          </CommandItem>
          {repos.map((r) => (
            <CommandItem
              key={r.id}
              value={`切换仓 ${r.owner}/${r.name}`}
              onSelect={() =>
                run(() => {
                  setRepoId(r.id);
                  navigate('/');
                })
              }
            >
              <FolderGit2 />
              切到仓 <span className="num">{r.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="外观">
          <CommandItem value="切换深浅色 深色 浅色 夜间" onSelect={() => run(theme.toggleMode)}>
            {theme.resolvedMode === 'dark' ? <Sun /> : <Moon />}
            切到{theme.resolvedMode === 'dark' ? '浅色' : '深色'}
          </CommandItem>
          {PALETTES.map((p) => (
            <CommandItem
              key={p.id}
              value={`主题色 ${p.name} ${p.en}`}
              onSelect={() => run(() => theme.setPalette(p.id))}
            >
              <Palette />
              主题色：{p.name}
              <span className="num text-xs text-muted-foreground">{p.en}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
