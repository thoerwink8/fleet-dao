import { FolderGit2 } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useRepo } from '../repo-context';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../ui/command';
import { NAV } from './nav';

/** ⌘K：跳页面（不进菜单的页也都在这里搜得到）、切仓。（主题只有一套、亮暗跟随系统，#3509 起没有切主题。） */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const navigate = useNavigate();
  const { repos, setRepoId } = useRepo();

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

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="sm:max-w-xl">
      <CommandInput placeholder="输入页面名、操作…" />
      <CommandList className="max-h-command-list">
        <CommandEmpty>没找到</CommandEmpty>
        {/* 菜单里的八项和不进菜单的页（定时任务、资源、发布记录、操作记录、渠道状态）都在这里 */}
        {NAV.map((g) => (
          <CommandGroup key={g.group} heading={g.group}>
            {g.items.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.to}
                  value={`${item.label} ${item.to} ${item.hint}`}
                  onSelect={() => run(() => navigate(item.to))}
                >
                  <Icon />
                  <span className="shrink-0">{item.label}</span>
                  <span className="min-w-0 truncate text-meta text-ink-3">{item.hint}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
        {repos.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="当前仓">
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
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
