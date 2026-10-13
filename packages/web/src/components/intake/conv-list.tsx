// 「我的需求」列表：电脑是左栏（窄屏收成窄条），手机是第一个画面。筛选：等我的｜全部｜我发起的。
import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';
import { FilterTabs } from '../layout/filter-tabs';
import { StatusBadge, StatusDot } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { Button } from '../ui/button';
import { type Human, type Req, statusView } from './data';
import { PeopleStack } from './parts';

export type ListFilter = 'wait' | 'all' | 'mine';

export function filterReqs(reqs: Req[], viewer: Human, f: ListFilter, selected: number | null = null): Req[] {
  // 正开着的那条始终留在列表里，不然点进去的需求会从列表上消失
  const keep = (r: Req) =>
    r.no === selected || (f === 'all' ? true : f === 'wait' ? r.mineFor === viewer : r.initiator === viewer);
  // 子需求跟着父条走：父条在，子条就在；子条在而父条不在，也带上父条
  const ids = new Set(reqs.filter(keep).map((r) => r.no));
  for (const r of reqs) if (r.parent && ids.has(r.no)) ids.add(r.parent);
  for (const r of reqs) if (r.parent && ids.has(r.parent)) ids.add(r.no);
  return reqs.filter((r) => ids.has(r.no));
}

export function waitCount(reqs: Req[], viewer: Human): number {
  return reqs.filter((r) => r.mineFor === viewer).length;
}

function Row({ r, on, phone, onSelect }: { r: Req; on: boolean; phone: boolean; onSelect: () => void }) {
  const v = statusView(r.status, r.gh, r.issue);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={on ? 'true' : undefined}
        data-child={r.parent ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col gap-1.5 border-b py-2.5 pr-3 text-left transition-colors duration-100',
          r.parent ? 'pl-8' : 'pl-3',
          phone && 'min-h-16 py-3',
          on ? 'bg-selected shadow-row-selected' : 'hover:bg-accent',
        )}
      >
        <span className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 text-meta text-muted-foreground tabular-nums">
            {r.parent ? '↳ ' : ''}需求 {r.no}
          </span>
          <span className="min-w-0 flex-1 text-body font-medium">{r.title}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge tone={v.tone} label={v.label} variant="dot" />
          {r.issue ? <Tag mono>#{r.issue}</Tag> : null}
          {r.pr ? <Tag mono>PR #{r.pr}</Tag> : null}
        </span>
        {r.waiting ? (
          <span
            className={cn('text-meta', r.mineFor ? 'font-medium text-ink-human' : 'text-muted-foreground')}
          >
            {r.waiting}
          </span>
        ) : null}
        {r.parent ? (
          <span className="text-meta text-muted-foreground">接着 需求 {r.parent} / #12</span>
        ) : null}
        <span className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <PeopleStack initiator={r.initiator} participants={r.participants} />
            <span className="min-w-0 truncate">{r.repo}</span>
          </span>
          <span className="shrink-0 tabular-nums">{r.updated}</span>
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
                    r.no === selected ? 'bg-selected shadow-row-selected' : 'hover:bg-accent',
                  )}
                >
                  <StatusDot tone={v.tone} className="size-2.5" />
                  <span className="text-meta font-medium tabular-nums">{r.no}</span>
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
        phone ? 'min-w-0 flex-1' : 'w-64 shrink-0 border-r transition-[width] duration-200 2xl:w-72',
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className={cn('min-w-0 flex-1 truncate', phone ? 'text-subtitle' : 'text-heading')}>我的需求</h2>
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
      <div className="space-y-2.5 px-3 py-2.5">
        <Button variant="outline" className={cn('w-full', phone && 'h-11 text-heading')} onClick={onNew}>
          <Plus />
          提新需求
        </Button>
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
          <Row key={r.no} r={r} on={r.no === selected} phone={phone} onSelect={() => onSelect(r.no)} />
        ))}
      </ul>
    </nav>
  );
}
