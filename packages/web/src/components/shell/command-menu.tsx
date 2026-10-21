import { FolderGit2 } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
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

/** ⌘K：跳页面、切仓。（主题只有一套、亮暗跟随系统，#3509 起没有切主题。） */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const navigate = useNavigate();
  const location = useLocation();
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
        <CommandGroup heading="跳转">
          {NAV.flatMap((g) => g.items).map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.to}
                value={`${item.label} ${item.hint}`}
                onSelect={() => run(() => navigate(item.to))}
              >
                <Icon />
                {item.label}
                <span className="truncate text-meta text-muted-foreground">{item.hint}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
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
                      if (location.pathname !== '/board') navigate('/');
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
