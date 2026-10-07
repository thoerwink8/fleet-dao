import { FolderGit2, Moon, Palette, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { PALETTES } from '../../lib/theme';
import { useRepo } from '../repo-context';
import { useTheme } from '../theme-provider';
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

/** ⌘K：跳页面、切仓、切主题。 */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const navigate = useNavigate();
  const { repos, setRepoId } = useRepo();
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
                <span className="truncate text-xs text-muted-foreground">{item.hint}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        {repos.length ? (
          <>
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
            <CommandSeparator />
          </>
        ) : null}
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
