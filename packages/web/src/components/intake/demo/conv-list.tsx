// 「我的需求」会话列表（像微信）：每行头像、标题、最后一条消息预览、时间、状态小点或「等我」角标。
// 电脑是左栏（窄屏收成窄条），手机是第一个画面。筛选：等我的｜全部｜我发起的。
import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FilterTabs } from '../../layout/filter-tabs';
import { StatusDot } from '../../layout/status-badge';
import { Tag } from '../../layout/tag';
import { Button } from '../../ui/button';
import { type Human, type Req, statusView } from './data';
import { ListAvatar } from './parts';

export type ListFilter = 'wait' | 'all' | 'mine';

export function filterReqs(reqs: Req[], viewer: Human, f: ListFilter, selected: number | null = null): Req[] {
  // 正开着的那条始终留在列表里，不然点进去的需求会从列表上消失
  const keep = (r: Req) =>
    r.no === selected || (f === 'all' ? true : f === 'wait' ? r.mineFor === viewer : r.initiator === viewer);
  const ids = new Set(reqs.filter(keep).map((r) => r.no));
  for (const r of reqs) if (r.parent && ids.has(r.no)) ids.add(r.parent);
  for (const r of reqs) if (r.parent && ids.has(r.parent)) ids.add(r.no);
  return reqs.filter((r) => ids.has(r.no));
}

export function waitCount(reqs: Req[], viewer: Human): number {
  return reqs.filter((r) => r.mineFor === viewer).length;
}

function Row({
  r,
  viewer,
  on,
  phone,
  onSelect,
}: {
  r: Req;
  viewer: Human;
  on: boolean;
  phone: boolean;
  onSelect: () => void;
}) {
  const v = statusView(r.status, r.gh, r.issue);
  const mine = r.mineFor === viewer;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={on ? 'true' : undefined}
        data-child={r.parent ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-3 border-b py-2.5 pr-3 text-left transition-colors duration-100',
          r.parent ? 'pl-8' : 'pl-3',
          phone && 'min-h-16',
          on ? 'bg-selected' : 'hover:bg-accent',
        )}
      >
        <ListAvatar initiator={r.initiator} participants={r.participants} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-body font-medium">{r.title}</span>
            <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{r.updated}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">{r.preview}</span>
            {mine ? (
              <Tag tone="human">等我</Tag>
            ) : (
              <span className="shrink-0" title={v.label}>
                <StatusDot tone={v.tone} />
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

export function ConvList({
  reqs,
  viewer,
  selected,
  onSelect,
  onNew,
  filter,
  onFilter,
  collapsed = false,
  onToggle,
  phone = false,
}: {
  reqs: Req[];
  viewer: Human;
  selected: number | null;
  onSelect: (no: number) => void;
  onNew: () => void;
  filter: ListFilter;
  onFilter: (f: ListFilter) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  phone?: boolean;
}) {
  const shown = filterReqs(reqs, viewer, filter, selected);
  const wait = waitCount(reqs, viewer);

  if (collapsed) {
    return (
      <nav
        aria-label="我的需求"
        data-collapsed
        className="flex min-h-0 w-16 shrink-0 flex-col border-r bg-panel transition-[width] duration-200"
      >
        <div className="flex flex-col items-center gap-2 border-b px-2 py-2">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onToggle}
            aria-label="展开我的需求"
            title="展开我的需求"
          >
            <PanelLeftOpen />
          </Button>
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
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {shown.map((r) => {
            const v = statusView(r.status, r.gh, r.issue);
            return (
              <li key={r.no}>
                <button
                  type="button"
                  onClick={() => onSelect(r.no)}
                  aria-current={r.no === selected ? 'true' : undefined}
                  title={`需求 ${r.no} ${r.title} · ${v.label}`}
                  className={cn(
                    'flex w-full flex-col items-center gap-1 border-b px-1 py-2.5',
                    r.no === selected ? 'bg-selected' : 'hover:bg-accent',
                  )}
                >
                  <ListAvatar initiator={r.initiator} participants={r.participants} />
                  <StatusDot tone={r.mineFor === viewer ? 'human' : v.tone} />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <nav
      aria-label="我的需求"
      className={cn(
        'flex min-h-0 flex-col bg-panel',
        phone ? 'min-w-0 flex-1' : 'w-72 shrink-0 border-r transition-[width] duration-200 2xl:w-80',
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <h2 className={cn('min-w-0 flex-1 truncate', phone ? 'text-subtitle' : 'text-heading')}>我的需求</h2>
        <Button
          size={phone ? 'icon' : 'icon-sm'}
          variant="ghost"
          onClick={onNew}
          aria-label="提新需求"
          title="提新需求"
        >
          <Plus />
        </Button>
        {phone ? null : (
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onToggle}
            aria-label="收起我的需求"
            title="收起成窄条"
          >
            <PanelLeftClose />
          </Button>
        )}
      </div>
      <div className="px-3 py-2.5">
        <FilterTabs
          aria-label="需求筛选"
          value={filter}
          onChange={onFilter}
          {...(phone ? { className: 'w-full [&_button]:h-11 [&_button]:flex-1' } : {})}
          items={[
            { id: 'wait', label: '等我的', count: wait },
            { id: 'all', label: '全部', count: reqs.length },
            { id: 'mine', label: '我发起的' },
          ]}
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto border-t scrollbar-thin">
        {shown.length === 0 ? (
          <li className="px-4 py-6 text-body text-muted-foreground">这一项下面没有需求。</li>
        ) : null}
        {shown.map((r) => (
          <Row
            key={r.no}
            r={r}
            viewer={viewer}
            on={r.no === selected}
            phone={phone}
            onSelect={() => onSelect(r.no)}
          />
        ))}
      </ul>
    </nav>
  );
}
