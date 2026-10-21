// 提需求页的需求列表（#2062，方案第三节）：电脑是左栏（窄屏收成窄条），手机是第一个画面。
// 三处：进行中（顶上「等我的｜全部｜我发起的」）、已归档（最下面一个入口）、最近删除（在已归档最下面）。两处都能按标题、原话、#单号搜。
// 一行：发起人头像（参与人小角标）、标题、最后一条消息、时间、状态小点或「等我」、搁置 N 天、结案后的单号；置顶的排前，
// 「接着这条提」开出的缩进挂在原条下面。多选能批量归档、批量删除：做不了的留在选中里写原因。
// 后端没接上需求表时写原因（unavailable），不画成「没有需求」。
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  CornerDownRight,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useRequestAction, useRequestDetails, useRequestList } from '../../api/client';
import type { RequestFilter, RequestRow, RequestView } from '../../api/types';
import { formatAgo, formatInDays } from '../../lib/format';
import { useSlowNow } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { EmptyState } from '../layout/empty-state';
import { FilterTabs } from '../layout/filter-tabs';
import { LoadError, LoadingRows } from '../layout/load-state';
import { Notice } from '../layout/notice';
import { SearchInput } from '../layout/search-input';
import { StatusDot } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { ListAvatar } from './people';
import { DELETE_CONFIRM_TEXT, RowRequestMenu } from './request-menu';
import { issueStateWord, nestRows, planBulk, previewOf, statusView, waitingLabel } from './request-view';

const VIEW_TITLE: Record<RequestView, string> = { active: '需求', archived: '已归档', deleted: '最近删除' };

export interface ListProps {
  view: RequestView;
  filter: RequestFilter;
  q: string;
  meId: string | undefined;
  selected: number | null;
  phone: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (seq: number) => void;
  onNew: () => void;
  onView: (view: RequestView) => void;
  onFilter: (f: RequestFilter) => void;
  onQ: (q: string) => void;
}

/** 搜索框边打边搜：停 300 毫秒才发。 */
function useDebounced(value: string, onCommit: (v: string) => void, ms = 300) {
  const first = useRef(true);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => commit.current(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
}

export function RequestList(p: ListProps) {
  const list = useRequestList({ view: p.view, filter: p.view === 'active' ? p.filter : 'all', q: p.q });
  const [text, setText] = useState(p.q);
  // 搜索词没变不提交：开发模式下 effect 跑两遍，空提交一次会把刚点开的那条（网址里的 r）冲掉
  useDebounced(text, (v) => {
    if (v.trim() !== p.q) p.onQ(v.trim());
  });
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [blocked, setBlocked] = useState<Map<number, string>>(new Map());
  const now = useSlowNow();

  // 换了处（进行中 / 已归档 / 最近删除）就退出多选
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟着 view 走
  useEffect(() => {
    setPicking(false);
    setPicked([]);
    setBlocked(new Map());
  }, [p.view]);

  const data = list.data;
  const rows = data && !data.unavailable ? nestRows(data.items) : [];
  const counts = data?.counts;

  if (p.collapsed && !p.phone) {
    return (
      <nav
        aria-label="需求列表"
        data-collapsed
        className="flex min-h-0 w-16 shrink-0 flex-col border-r bg-panel transition-[width] duration-200"
      >
        <div className="flex flex-col items-center gap-2 border-b px-2 py-2">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={p.onToggle}
            aria-label="展开需求列表"
            title="展开需求列表"
          >
            <PanelLeftOpen />
          </Button>
          <Button
            size="icon"
            variant="outline"
            className="w-full"
            onClick={p.onNew}
            aria-label="提新需求"
            title="提新需求"
          >
            <Plus />
          </Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {rows.map(({ row: r }) => {
            const v = statusView(r);
            return (
              <li key={r.seq}>
                <button
                  type="button"
                  onClick={() => p.onSelect(r.seq)}
                  aria-current={r.seq === p.selected ? 'true' : undefined}
                  title={`需求 ${r.seq} ${r.title} · ${r.waitingOnMe ? waitingLabel(r.waitingOnMe) : v.label}`}
                  className={cn(
                    'flex w-full flex-col items-center gap-1 border-b px-1 py-2.5',
                    r.seq === p.selected ? 'bg-selected' : 'hover:bg-accent',
                  )}
                >
                  <ListAvatar initiator={r.initiator} participants={r.participants} meId={p.meId} />
                  <StatusDot tone={r.waitingOnMe ? 'human' : v.tone} />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  const togglePick = (seq: number) => {
    setPicked((s) => (s.includes(seq) ? s.filter((x) => x !== seq) : [...s, seq]));
    setBlocked((b) => {
      if (!b.has(seq)) return b;
      const n = new Map(b);
      n.delete(seq);
      return n;
    });
  };

  return (
    <nav
      aria-label="需求列表"
      data-request-list={p.view}
      className={cn(
        'flex min-h-0 flex-col bg-panel',
        p.phone ? 'min-w-0 flex-1' : 'w-80 shrink-0 border-r transition-[width] duration-200',
      )}
    >
      <div className="flex items-center gap-1 px-3 pt-2.5">
        {p.view !== 'active' ? (
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => p.onView(p.view === 'deleted' ? 'archived' : 'active')}
            aria-label={p.view === 'deleted' ? '回到已归档' : '回到进行中'}
            title={p.view === 'deleted' ? '回到已归档' : '回到进行中'}
          >
            <ArrowLeft />
          </Button>
        ) : null}
        <h2 className={cn('min-w-0 flex-1 truncate', p.phone ? 'text-title' : 'text-heading')}>
          {VIEW_TITLE[p.view]}
        </h2>
        {p.view !== 'deleted' ? (
          <Button
            size={p.phone ? 'icon' : 'icon-sm'}
            variant="ghost"
            aria-pressed={picking}
            onClick={() => {
              setPicking(!picking);
              setPicked([]);
              setBlocked(new Map());
            }}
            aria-label={picking ? '退出多选' : '多选'}
            title={picking ? '退出多选' : '多选：批量归档、批量删除'}
            className={cn(picking && 'bg-selected')}
          >
            <ListChecks />
          </Button>
        ) : null}
        {p.view === 'active' ? (
          <Button
            size={p.phone ? 'icon' : 'icon-sm'}
            variant="ghost"
            onClick={p.onNew}
            aria-label="提新需求"
            title="提新需求"
          >
            <Plus />
          </Button>
        ) : null}
        {p.phone ? null : (
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={p.onToggle}
            aria-label="收起需求列表"
            title="收起成窄条"
          >
            <PanelLeftClose />
          </Button>
        )}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <SearchInput
          value={text}
          onChange={setText}
          placeholder="搜标题、原话、#单号"
          aria-label="搜需求"
          className="md:max-w-none"
        />
        {p.view === 'active' ? (
          <FilterTabs
            aria-label="需求筛选"
            value={p.filter}
            onChange={p.onFilter}
            {...(p.phone ? { className: 'w-full [&_button]:flex-1' } : {})}
            items={[
              { id: 'todo', label: '等我的', count: counts ? counts.todo : null },
              { id: 'all', label: '全部', count: counts ? counts.all : null },
              { id: 'mine', label: '我发起的', count: counts ? counts.mine : null },
            ]}
          />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t scrollbar-thin">
        {list.error && !data ? (
          <div className="p-3">
            <LoadError error={list.error} what="需求列表" onRetry={() => void list.refetch()} />
          </div>
        ) : null}
        {data?.unavailable ? (
          <div className="p-3" data-requests-unavailable>
            <Notice tone="stall" title="提需求现在用不了">
              {data.unavailable}
            </Notice>
          </div>
        ) : null}
        {list.isPending ? (
          <div className="p-3">
            <LoadingRows rows={5} />
          </div>
        ) : null}
        {data && !data.unavailable && rows.length === 0 ? (
          <EmptyState
            size="inline"
            title={
              p.q
                ? `没有搜到「${p.q}」`
                : p.view === 'deleted'
                  ? '最近删除里没有东西'
                  : p.view === 'archived'
                    ? '还没有归档的需求'
                    : p.filter === 'todo'
                      ? '没有等你的'
                      : '这一项下面没有需求'
            }
          />
        ) : null}
        <ul data-request-rows>
          {rows.map(({ row, child }) => (
            <Row
              key={row.seq}
              r={row}
              child={child}
              meId={p.meId}
              on={row.seq === p.selected}
              phone={p.phone}
              now={now}
              picking={picking}
              picked={picked.includes(row.seq)}
              blockedWhy={blocked.get(row.seq)}
              onSelect={() => (picking ? togglePick(row.seq) : p.onSelect(row.seq))}
            />
          ))}
        </ul>
        {data && !data.unavailable && p.view === 'active' ? (
          <ViewEntry
            icon={Archive}
            label="已归档"
            count={data.counts.archived}
            onClick={() => p.onView('archived')}
          />
        ) : null}
        {data && !data.unavailable && p.view === 'archived' ? (
          <ViewEntry
            icon={Trash2}
            label="最近删除"
            count={data.counts.deleted}
            onClick={() => p.onView('deleted')}
          />
        ) : null}
        {p.view === 'deleted' ? (
          <p className="px-4 py-3 text-meta text-muted-foreground">
            只有你删的在这里；删了满 30 天彻底删除，之前点开能恢复。
          </p>
        ) : null}
      </div>
      {picking ? (
        <BulkBar
          picked={picked}
          view={p.view}
          onClear={() => {
            setPicked([]);
            setBlocked(new Map());
          }}
          onResult={(done, still) => {
            setPicked(still.map((s) => s.seq));
            setBlocked(new Map(still.map((s) => [s.seq, s.why])));
            if (done > 0 && still.length === 0) setPicking(false);
          }}
        />
      ) : null}
    </nav>
  );
}

function ViewEntry({
  icon: Icon,
  label,
  count,
  onClick,
}: {
  icon: typeof Archive;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-view-entry={label}
      className="flex w-full items-center gap-2 px-4 py-3 text-left text-body text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground max-md:min-h-12"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="flex-1">
        {label}（<span className="tabular-nums">{count}</span>）
      </span>
      <ChevronRight className="size-4 shrink-0" aria-hidden />
    </button>
  );
}

/** 手机上长按一行出菜单（没有悬停）。 */
const LONG_PRESS_MS = 500;

function Row({
  r,
  child,
  meId,
  on,
  phone,
  now,
  picking,
  picked,
  blockedWhy,
  onSelect,
}: {
  r: RequestRow;
  child: boolean;
  meId: string | undefined;
  on: boolean;
  phone: boolean;
  now: number;
  picking: boolean;
  picked: boolean;
  blockedWhy: string | undefined;
  onSelect: () => void;
}) {
  const v = statusView(r);
  const [menu, setMenu] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  const startPress = () => {
    if (!phone || picking) return;
    longPressed.current = false;
    press.current = setTimeout(() => {
      longPressed.current = true;
      setMenu(true);
    }, LONG_PRESS_MS);
  };
  const endPress = () => clearTimeout(press.current);
  const preview = r.deletedAt && r.purgeAt ? `${formatInDays(r.purgeAt, now)}彻底删除` : previewOf(r);
  return (
    <li
      className={cn('group/row relative flex items-center border-b', on ? 'bg-selected' : 'hover:bg-accent')}
      data-request-row={r.seq}
      data-child={child ? 'true' : undefined}
      data-picked={picked ? 'true' : undefined}
    >
      <button
        type="button"
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          onSelect();
        }}
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onContextMenu={(e) => {
          if (phone) e.preventDefault();
        }}
        aria-current={on ? 'true' : undefined}
        aria-pressed={picking ? picked : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-1 text-left',
          child ? 'pl-8' : 'pl-3',
          phone && 'min-h-16',
        )}
      >
        {picking ? (
          <span
            aria-hidden
            className={cn(
              'grid size-5 shrink-0 place-items-center rounded-sm border',
              picked ? 'border-brand bg-brand text-brand-foreground' : 'border-input bg-background',
            )}
          >
            {picked ? <Check className="size-3.5" /> : null}
          </span>
        ) : null}
        {child ? (
          <CornerDownRight className="-ml-5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : null}
        <ListAvatar initiator={r.initiator} participants={r.participants} meId={meId} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className="min-w-0 flex-1 truncate text-body font-medium"
              title={`需求 ${r.seq} ${r.title}`}
            >
              {r.title}
            </span>
            {r.pinned ? (
              <Pin className="size-3 shrink-0 self-center text-muted-foreground" aria-label="置顶" />
            ) : null}
            <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
              {/* 「最后有动静」只会是过去：页面的钟每分钟才走一格，刚发的那句比它新，按「刚刚」算，不写「5 秒后」 */}
              {formatAgo(r.lastActivityAt, Math.max(now, Date.parse(r.lastActivityAt)))}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground" title={preview}>
              {preview}
            </span>
            {r.idleDays !== null ? (
              <Tag tone="stall" className="shrink-0">
                搁置 {r.idleDays} 天
              </Tag>
            ) : null}
            {r.issueRefs.map((i) => (
              <span key={`${i.repo}#${i.number}`} title={`${i.repo} #${i.number} ${issueStateWord(i.state)}`}>
                <Tag mono>#{i.number}</Tag>
              </span>
            ))}
            {r.waitingOnMe ? (
              <span title={waitingLabel(r.waitingOnMe)} data-waiting={r.waitingOnMe}>
                <Tag tone="human">等我{r.unread > 0 ? ` ${r.unread}` : ''}</Tag>
              </span>
            ) : (
              <span className="shrink-0" title={v.label}>
                <StatusDot tone={v.tone} />
                <span className="sr-only">{v.label}</span>
              </span>
            )}
          </span>
          {blockedWhy ? (
            <span
              className="mt-1 block text-meta whitespace-normal text-ink-stall"
              data-blocked-why
              role="status"
            >
              {blockedWhy}
            </span>
          ) : null}
        </span>
      </button>
      {picking ? null : (
        <span className="shrink-0 pr-2">
          <RowRequestMenu seq={r.seq} title={r.title} open={menu} onOpenChange={setMenu} />
        </span>
      )}
    </li>
  );
}

/** 多选的底栏：批量归档、批量删除。只做做得了的，做不了的留在选中里写原因（判据在各条详情的 actions 里）。 */
function BulkBar({
  picked,
  view,
  onClear,
  onResult,
}: {
  picked: number[];
  view: RequestView;
  onClear: () => void;
  onResult: (done: number, still: { seq: number; why: string }[]) => void;
}) {
  const details = useRequestDetails(picked);
  const act = useRequestAction();
  const [busy, setBusy] = useState<'archive' | 'delete' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const targets = picked.map((seq, i) => {
    const q = details[i];
    return {
      seq,
      actions: q?.data?.actions,
      error: q?.error ? errorText(q.error) : undefined,
    };
  });

  const runBulk = async (kind: 'archive' | 'delete') => {
    const plan = planBulk(kind, targets);
    setBusy(kind);
    const still = [...plan.blocked];
    let done = 0;
    for (const seq of plan.doable) {
      try {
        await act.mutateAsync({ seq, body: { action: kind } });
        done += 1;
      } catch (err) {
        still.push({ seq, why: errorText(err) });
      }
    }
    setBusy(null);
    const word = kind === 'archive' ? '归档' : '删除';
    if (done > 0)
      toast.success(`${word}了 ${done} 条${kind === 'delete' ? '，30 天内能在「最近删除」里恢复' : ''}`);
    if (still.length > 0) toast.warning(`${still.length} 条没${word}，原因写在每一行下面，还选着`);
    onResult(done, still);
  };

  const n = picked.length;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t bg-panel px-3 py-2.5" data-bulk-bar>
      <span className="min-w-0 flex-1 text-meta text-muted-foreground">
        已选 <span className="tabular-nums">{n}</span> 条
      </span>
      {view === 'active' || view === 'archived' ? (
        <>
          {view === 'active' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={n === 0}
              loading={busy === 'archive'}
              onClick={() => void runBulk('archive')}
            >
              归档
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={n === 0}
            loading={busy === 'delete'}
            onClick={() => setConfirm(true)}
            className="text-destructive"
          >
            删除
          </Button>
        </>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onClear} disabled={n === 0}>
        清空
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent data-bulk-delete-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>删除选中的 {n} 条？</AlertDialogTitle>
            <AlertDialogDescription>
              只删能删的（讨论中、只有发起人说过话、没提交过拍板的）；删不了的留在选中里写明原因。
              {DELETE_CONFIRM_TEXT}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不删</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onConfirm={() => runBulk('delete')}>
              删除能删的
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
