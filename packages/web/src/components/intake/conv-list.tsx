// 左栏「我的需求」。窄屏（<1536）默认收成只有状态点的窄条，点箭头展开；宽屏默认展开。
import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';
import { StatusBadge, StatusDot } from '../layout/status-badge';
import { Button } from '../ui/button';
import { type Conv, STATUS_VIEW } from './data';

export function ConvList({
  convs,
  selected,
  onSelect,
  onNew,
  collapsed,
  onToggle,
}: {
  convs: Conv[];
  selected: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <nav
      aria-label="我的需求"
      data-collapsed={collapsed}
      className={cn(
        'flex min-h-0 shrink-0 flex-col border-r bg-panel transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-64 2xl:w-72',
      )}
    >
      <div className={cn('flex items-center gap-2 border-b px-3 py-2', collapsed && 'flex-col px-2')}>
        {collapsed ? null : <h2 className="min-w-0 flex-1 truncate text-heading">我的需求</h2>}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggle}
          aria-label={collapsed ? '展开我的需求' : '收起我的需求'}
          title={collapsed ? '展开我的需求' : '收起成窄条'}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      </div>
      <div className="px-3 py-2.5">
        {collapsed ? (
          <Button
            size="icon"
            variant="outline"
            className="w-full"
            onClick={onNew}
            aria-label="提新需求"
            title="提新需求"
          >
            <Plus />
          </Button>
        ) : (
          <Button variant="outline" className="w-full" onClick={onNew}>
            <Plus />
            提新需求
          </Button>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {convs.map((c) => {
          const v = STATUS_VIEW[c.status];
          const on = c.id === selected;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                aria-current={on ? 'true' : undefined}
                title={collapsed ? `${c.title} · ${v.label(c.issue)}` : undefined}
                className={cn(
                  'relative flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left transition-colors duration-100',
                  on ? 'bg-selected shadow-row-selected' : 'hover:bg-accent',
                  collapsed && 'items-center px-2',
                )}
              >
                {collapsed ? (
                  <>
                    <StatusDot tone={v.tone} className="size-2.5" />
                    <span className="text-meta font-medium">{c.title.slice(0, 2)}</span>
                  </>
                ) : (
                  <>
                    <span className="line-clamp-2 text-body font-medium">{c.title}</span>
                    <span className="flex items-center justify-between gap-2">
                      <StatusBadge tone={v.tone} label={v.label(c.issue)} variant="dot" />
                    </span>
                    <span className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
                      <span className="min-w-0 truncate">{c.repo}</span>
                      <span className="shrink-0 tabular-nums">{c.updated}</span>
                    </span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
