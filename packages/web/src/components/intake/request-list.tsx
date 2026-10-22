// 提需求页的需求列表（#2062，方案第三节）：电脑是左栏（窄屏收成窄条），手机是第一个画面。
// 三处：进行中（顶上「等我的｜全部｜我发起的」）、已归档（最下面一个入口）、最近删除（在已归档最下面）。两处都能按标题、原话、#单号搜。
// 一行：发起人头像（参与人小角标）、标题、最后一条消息、时间、状态或「等我」、搁置 N 天、结案后的单号；置顶的排前，
// 「接着这条提」开出的缩进挂在原条下面。多选能批量归档、批量删除：做不了的留在选中里写原因。
// 后端没接上需求表时写原因（unavailable），不画成「没有需求」。
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useRequestAction, useRequestDetails, useRequestList } from '../../api/client';
import type { RequestFilter, RequestRow, RequestView } from '../../api/types';
import { formatAgo, formatInDays } from '../../lib/format';
import { useSlowNow } from '../../lib/hooks';
import { statusEntry } from '../../theme/status-dict';
import { AvatarPair } from '../layout/avatar';
import { Button } from '../layout/button';
import { ChoiceRow } from '../layout/choice-row';
import { ConfirmDialog } from '../layout/confirm-dialog';
import { EmptyState } from '../layout/empty-state';
import { FilterTabs } from '../layout/filter-tabs';
import { List, ListRow } from '../layout/list';
import { LoadError, LoadingRows } from '../layout/load-state';
import { Notice } from '../layout/notice';
import { Pane } from '../layout/pane';
import { SearchInput } from '../layout/search-input';
import { Stack } from '../layout/stack';
import { LevelDot, StatusBadge } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { Title } from '../layout/title';
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
      <Pane
        label="需求列表"
        as="nav"
        size="rail"
        data-collapsed=""
        head={
          <Stack align="center" gap="sm">
            <Button iconOnly size="sm" aria-label="展开需求列表" title="展开需求列表" onClick={p.onToggle}>
              <PanelLeftOpen />
            </Button>
            <Button
              iconOnly
              size="sm"
              variant="outline"
              aria-label="提新需求"
              title="提新需求"
              onClick={p.onNew}
            >
              <Plus />
            </Button>
          </Stack>
        }
      >
        <List divided={false}>
          {rows.map(({ row: r }) => {
            const v = statusView(r);
            return (
              <ChoiceRow
                key={r.seq}
                compact
                selected={r.seq === p.selected}
                title={`需求 ${r.seq} ${r.title} · ${r.waitingOnMe ? waitingLabel(r.waitingOnMe) : v.label}`}
                leading={<AvatarPair main={r.initiator} extra={r.participants[0]} meId={p.meId} />}
                tags={<LevelDot level={r.waitingOnMe ? 'default' : statusEntry(v.status).level} />}
                onClick={() => p.onSelect(r.seq)}
              />
            );
          })}
        </List>
      </Pane>
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
    <Pane
      label="需求列表"
      as="nav"
      size="list"
      data-request-list={p.view}
      head={
        <Stack gap="md">
          <Stack direction="horizontal" gap="sm" align="center">
            {p.view !== 'active' ? (
              <Button
                iconOnly
                size="sm"
                aria-label={p.view === 'deleted' ? '回到已归档' : '回到进行中'}
                title={p.view === 'deleted' ? '回到已归档' : '回到进行中'}
                onClick={() => p.onView(p.view === 'deleted' ? 'archived' : 'active')}
              >
                <ChevronLeft />
              </Button>
            ) : null}
            <Title truncate>{VIEW_TITLE[p.view]}</Title>
            <Stack direction="horizontal" gap="sm" align="center" justify="end">
              {p.view !== 'deleted' ? (
                <Button
                  size="sm"
                  variant="text"
                  aria-pressed={picking}
                  title={picking ? '退出多选' : '多选：批量归档、批量删除'}
                  onClick={() => {
                    setPicking(!picking);
                    setPicked([]);
                    setBlocked(new Map());
                  }}
                >
                  {picking ? '退出多选' : '多选'}
                </Button>
              ) : null}
              {p.view === 'active' ? (
                <Button size="sm" variant="outline" aria-label="提新需求" onClick={p.onNew}>
                  提新需求
                </Button>
              ) : null}
              {p.phone ? null : (
                <Button iconOnly size="sm" aria-label="收起需求列表" title="收起成窄条" onClick={p.onToggle}>
                  <PanelLeftClose />
                </Button>
              )}
            </Stack>
          </Stack>
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="搜标题、原话、#单号"
            aria-label="搜需求"
          />
          {p.view === 'active' ? (
            <FilterTabs
              aria-label="需求筛选"
              mode="toggle"
              variant="segmented"
              value={p.filter}
              onChange={p.onFilter}
              items={[
                { id: 'todo', label: '等我的', count: counts ? counts.todo : null },
                { id: 'all', label: '全部', count: counts ? counts.all : null },
                { id: 'mine', label: '我发起的', count: counts ? counts.mine : null },
              ]}
            />
          ) : null}
        </Stack>
      }
      foot={
        picking ? (
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
        ) : undefined
      }
    >
      {list.error && !data ? (
        <Stack>
          <LoadError error={list.error} what="需求列表" onRetry={() => void list.refetch()} />
        </Stack>
      ) : null}
      {data?.unavailable ? (
        <div data-requests-unavailable="">
          <Notice tone="stall" title="提需求现在用不了">
            {data.unavailable}
          </Notice>
        </div>
      ) : null}
      {list.isPending ? <LoadingRows rows={5} /> : null}
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
      <List divided={false} data-request-rows="">
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
      </List>
      {data && !data.unavailable && p.view === 'active' ? (
        <ViewEntry label="已归档" count={data.counts.archived} onClick={() => p.onView('archived')} />
      ) : null}
      {data && !data.unavailable && p.view === 'archived' ? (
        <ViewEntry label="最近删除" count={data.counts.deleted} onClick={() => p.onView('deleted')} />
      ) : null}
      {p.view === 'deleted' ? (
        <Notice tone="info">只有你删的在这里；删了满 30 天彻底删除，之前点开能恢复。</Notice>
      ) : null}
    </Pane>
  );
}

function ViewEntry({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  return (
    <List divided={false}>
      <ListRow
        data-view-entry={label}
        onClick={onClick}
        title={`${label}（${count}）`}
        trailing={<ChevronRight aria-hidden />}
      />
    </List>
  );
}

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
  const preview = r.deletedAt && r.purgeAt ? `${formatInDays(r.purgeAt, now)}彻底删除` : previewOf(r);
  return (
    <ChoiceRow
      data-request-row={String(r.seq)}
      {...(child ? { 'data-child': 'true' } : {})}
      {...(picked ? { 'data-picked': 'true' } : {})}
      selected={on}
      indent={child}
      checked={picking ? picked : undefined}
      onClick={onSelect}
      {...(phone && !picking ? { onLongPress: () => setMenu(true) } : {})}
      leading={
        <AvatarPair
          main={r.initiator}
          extra={r.participants[0]}
          meId={meId}
          title={`发起人 ${r.initiator.name}${r.participants.length ? `；参与 ${r.participants.map((x) => x.name).join('、')}` : ''}`}
        />
      }
      title={r.title}
      titleHint={`需求 ${r.seq} ${r.title}`}
      time={formatAgo(r.lastActivityAt, Math.max(now, Date.parse(r.lastActivityAt)))}
      meta={<span title={preview}>{preview}</span>}
      tags={
        <>
          {r.pinned ? <Tag>置顶</Tag> : null}
          {r.idleDays !== null ? <Tag tone="warning">搁置 {r.idleDays} 天</Tag> : null}
          {r.issueRefs.map((i) => (
            <span key={`${i.repo}#${i.number}`} title={`${i.repo} #${i.number} ${issueStateWord(i.state)}`}>
              <Tag mono>#{i.number}</Tag>
            </span>
          ))}
          {r.waitingOnMe ? (
            <span title={waitingLabel(r.waitingOnMe)} data-waiting={r.waitingOnMe}>
              <Tag>等我{r.unread > 0 ? ` ${r.unread}` : ''}</Tag>
            </span>
          ) : (
            <StatusBadge status={v.status} variant="dot" title={v.label} />
          )}
        </>
      }
      {...(blockedWhy ? { note: <span data-blocked-why="">{blockedWhy}</span> } : {})}
      menu={
        picking ? undefined : (
          <RowRequestMenu seq={r.seq} title={r.title} open={menu} onOpenChange={setMenu} />
        )
      }
    />
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
  const none = n === 0 ? '还没选' : undefined;
  return (
    <div data-bulk-bar="">
      <Stack direction="horizontal" gap="sm" align="center" wrap>
        <Text size="meta" tone="muted">
          已选 {n} 条
        </Text>
        {view === 'active' || view === 'archived' ? (
          <>
            {view === 'active' ? (
              <Button
                size="sm"
                variant="secondary"
                loading={busy === 'archive'}
                {...(none ? { disabledReason: none } : {})}
                onClick={() => void runBulk('archive')}
              >
                归档
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="danger"
              loading={busy === 'delete'}
              {...(none ? { disabledReason: none } : {})}
              onClick={() => setConfirm(true)}
            >
              删除
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="text" {...(none ? { disabledReason: none } : {})} onClick={onClear}>
          清空
        </Button>
      </Stack>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`删除选中的 ${n} 条？`}
        description={`只删能删的（讨论中、只有发起人说过话、没提交过拍板的）；删不了的留在选中里写明原因。${DELETE_CONFIRM_TEXT}`}
        danger
        confirmText="删除能删的"
        cancelText="先不删"
        onConfirm={() => runBulk('delete')}
      />
    </div>
  );
}
