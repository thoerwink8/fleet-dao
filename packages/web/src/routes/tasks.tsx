// 任务列表页（/tasks，#1639）：所有仓、所有状态的单子，最近更新在前。
// 顶上一排状态（带各自的数）、仓、搜索；筛选全写在地址栏（?status=&repo=&q=），刷新、返回都保得住。
// 点一行进 /tasks/:taskId，链接带着 ?from=<这页的地址>，详情页左上的「返回」据此回到这里并带回筛选。
// 往下滚到底自动读下一页，也能点「加载更多」。读不到写「没读成」和原因、给重试；筛出来是空的写「没有符合的任务」，不拿空列表冒充没有。
// 手机宽度一行是一张卡片，md 起是十二栏的表格行。

import { ListChecks, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useRepos, useTaskList } from '../api/client';
import type { TaskList, TaskListRow } from '../api/types';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { List, ListRow } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { NativeSelect } from '../components/layout/native-select';
import { Page } from '../components/layout/page';
import { SearchInput } from '../components/layout/search-input';
import { Section } from '../components/layout/section';
import { StatusBadge } from '../components/layout/status-badge';
import { Toolbar } from '../components/layout/toolbar';
import { Button } from '../components/ui/button';
import { formatAgo, formatDateTime, formatUsd, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useShownError } from '../lib/shown-error';
import {
  detailLink,
  filterOf,
  GROUP_TABS,
  isFiltered,
  listLocation,
  paramsWithView,
  rowStatus,
  segmentText,
  type TaskListView,
  viewOfParams,
} from '../lib/task-list';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('任务') }];
}

/** 任务列表靠推送更新（tasks、runs 表一变就重拉），没有自己的轮询。超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const TASKS_STALE_AFTER_MS = 5 * TIME.MIN;

/** 搜索框停下多久才去读。 */
const SEARCH_DEBOUNCE_MS = 300;

function Cost({ cost }: { cost: TaskListRow['cost'] }) {
  // 读不到留空：仍挂悬停说明，不写「没读到」（叫停、已结束的单同样；#1751）
  if (cost.usd === null) {
    // 标准档位占位，留给悬停说明一块可指区域；不用任意值（lint-design R0 / #182）
    return <span className="inline-block size-4" title={cost.note} data-cost-empty />;
  }
  return (
    <span className="num" title={cost.note}>
      {formatUsd(cost.usd)}
      {cost.note ? <span className="whitespace-nowrap text-ink-stall"> 偏低</span> : null}
    </span>
  );
}

/** 十二栏怎么分：花费列整列都读不到时不画，空出来的宽度给标题和模型（#1902）。类名写全，Tailwind 才扫得到。 */
const COLS = {
  withCost: { title: 'md:col-span-4', model: 'md:col-span-2' },
  noCost: { title: 'md:col-span-5', model: 'md:col-span-3' },
} as const;

/** 桌面十二栏表头：和 Row 同一套 col-span，手机上不画（每行自己带两行上下文）。 */
function ListHeader({ showCost }: { showCost: boolean }) {
  const cols = showCost ? COLS.withCost : COLS.noCost;
  return (
    <li
      className="hidden px-4 py-2 text-meta text-muted-foreground md:grid md:grid-cols-12 md:items-center md:gap-x-4"
      aria-hidden
      data-list-header
    >
      <span className={cols.title}>单</span>
      <span className="md:col-span-2">状态</span>
      <span className={cols.model}>模型</span>
      {showCost ? <span className="text-right md:col-span-2">花费</span> : null}
      <span className="text-right md:col-span-2">更新</span>
    </li>
  );
}

/**
 * 一行：桌面单行（行高回 h-row，标题前带仓和单号，开单时间放进时间格的悬停）；
 * 手机两行：标题 / 状态 · 模型 · 时间（#1902）。
 */
function Row({
  row,
  from,
  now,
  showCost,
}: {
  row: TaskListRow;
  from: string;
  now: number;
  showCost: boolean;
}) {
  const status = rowStatus(row);
  const cols = showCost ? COLS.withCost : COLS.noCost;
  return (
    <ListRow
      href={detailLink(row.taskId, from)}
      summary={
        <div className="grid w-full min-w-0 gap-y-0.5 md:grid-cols-12 md:items-center md:gap-x-4">
          <div className={cn('flex min-w-0 items-baseline gap-x-2', cols.title)}>
            <span className="num shrink-0 text-meta text-muted-foreground max-md:hidden">
              {row.repo}#{row.issueNumber}
            </span>
            <span className="truncate text-body font-medium">{row.title}</span>
          </div>
          {/* 手机上排成第二行；md 起各自占一栏（contents 让它们直接成为外层十二栏网格的格子） */}
          <div className="flex min-w-0 items-center gap-x-2 md:contents">
            <div className="flex shrink-0 items-center gap-x-2 md:col-span-2">
              <StatusBadge tone={status.tone} label={status.label} />
              {row.segment === null ? null : (
                <span className="text-meta whitespace-nowrap text-muted-foreground max-md:hidden">
                  {segmentText[row.segment]}
                </span>
              )}
            </div>
            <div
              className={cn(
                'min-w-0 flex-1 truncate text-body text-muted-foreground max-md:text-meta',
                cols.model,
              )}
              title="用的模型"
            >
              {row.model ?? <span title="这张单还没有会话记录">没记模型</span>}
            </div>
            {showCost ? (
              <div className="text-body max-md:hidden md:col-span-2 md:text-right">
                <Cost cost={row.cost} />
              </div>
            ) : null}
            <div
              className="flex shrink-0 items-center gap-x-3 text-meta text-muted-foreground md:col-span-2 md:justify-end"
              title={`开单 ${formatDateTime(row.createdAt)}；更新 ${formatDateTime(row.updatedAt)}`}
            >
              {row.prNumber === null ? null : <span className="num max-md:hidden">PR #{row.prNumber}</span>}
              <span className="num whitespace-nowrap">{formatAgo(row.updatedAt, now)}</span>
            </div>
          </div>
        </div>
      }
    />
  );
}

function StatusTabs({
  value,
  counts,
  onChange,
}: {
  value: TaskListView['status'];
  counts: TaskList['counts'] | undefined;
  onChange: (next: TaskListView['status']) => void;
}) {
  return (
    <FilterTabs
      aria-label="按状态"
      items={GROUP_TABS.map((tab) => ({
        id: tab.id,
        label: tab.label,
        ...(counts ? { count: counts[tab.id] } : {}),
      }))}
      value={value ?? 'all'}
      onChange={(id) => onChange(id === 'all' ? undefined : id)}
    />
  );
}

/** 滚到列表底下就读下一页；没有 IntersectionObserver 的环境（测试）只靠「加载更多」按钮。 */
function useLoadMoreOnScroll(enabled: boolean, load: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadRef.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled]);
  return ref;
}

export default function TasksPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const view = useMemo(() => viewOfParams(params), [params]);
  const filter = useMemo(() => filterOf(view), [view]);
  const list = useTaskList(filter);
  // 只管「整页没读成」；已经有数据后读下一页失败，由列表底下那一条说
  const shownError = useShownError(JSON.stringify(filter), {
    error: list.data ? null : list.error,
    data: list.data,
  });
  const repos = useRepos();
  const now = useNow();

  const setView = (next: TaskListView) => setParams((prev) => paramsWithView(prev, next), { replace: true });

  // 搜索框：打字先记在本地，停下 300 毫秒再写进地址栏（每敲一个字都去读，后端白忙）。地址栏被别处改了（返回、清除筛选）就跟着变。
  const [typed, setTyped] = useState(view.q);
  useEffect(() => setTyped(view.q), [view.q]);
  useEffect(() => {
    if (typed === view.q) return;
    const timer = setTimeout(() => setView({ ...view, q: typed }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // 翻页过程中单子的更新时刻会变，同一张单可能在两页都出现：只留先出现的那一行
  const rows = useMemo(() => {
    const seen = new Map<string, TaskListRow>();
    for (const page of list.data?.pages ?? [])
      for (const row of page.items) if (!seen.has(row.taskId)) seen.set(row.taskId, row);
    return [...seen.values()];
  }, [list.data]);
  // 已读到的行花费全读不到：整列不画（#1902）
  const showCost = rows.some((r) => r.cost.usd !== null);
  const counts = list.data?.pages[0]?.counts;
  const sentinel = useLoadMoreOnScroll(
    Boolean(list.hasNextPage) && !list.isFetchingNextPage && !list.isFetchNextPageError,
    () => void list.fetchNextPage(),
  );

  const from = listLocation(location.search);
  const filtered = isFiltered(view);
  const clear = () => {
    setTyped('');
    setView({ status: undefined, repoId: undefined, q: '' });
  };

  return (
    <Page
      title="任务"
      description="所有仓的单子，最近有动静的在前：在跑的、排队的、等人的，做完、失败、叫停的也都在。"
      refresh={{
        onRefresh: () => void list.refetch(),
        isFetching: list.isFetching,
        dataUpdatedAt: list.dataUpdatedAt > now ? now : list.dataUpdatedAt,
        staleAfterMs: TASKS_STALE_AFTER_MS,
      }}
    >
      <div className="max-w-task-table" data-task-table>
        <Toolbar
          start={
            <StatusTabs
              value={view.status}
              counts={counts}
              onChange={(status) => setView({ ...view, status })}
            />
          }
          end={
            <>
              <NativeSelect
                aria-label="按仓筛选"
                value={view.repoId ?? ''}
                onChange={(e) => setView({ ...view, repoId: e.target.value || undefined })}
                className="max-md:w-full"
              >
                <option value="">全部仓</option>
                {(repos.data?.repos ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.owner}/{r.name}
                  </option>
                ))}
              </NativeSelect>
              <SearchInput
                value={typed}
                onChange={setTyped}
                placeholder="搜单号或标题"
                aria-label="搜索任务：单号精确，标题包含"
                className="md:w-64"
              />
            </>
          }
        />
        {shownError ? (
          <div className="mb-3">
            <LoadError what="任务列表" error={shownError} onRetry={() => void list.refetch()} />
          </div>
        ) : null}
        <Section flush>
          {!list.data ? (
            shownError ? (
              <p className="px-4 py-10 text-center text-body text-ink-fail">
                没读到任务列表，这里空着不代表没有任务
              </p>
            ) : (
              <div className="p-4">
                <LoadingRows rows={6} />
              </div>
            )
          ) : rows.length === 0 ? (
            <EmptyState
              icon={filtered ? SearchX : ListChecks}
              title="没有符合的任务"
              hint={
                filtered ? (
                  <>
                    <p>换个状态、仓或搜索词试试。</p>
                    <div className="mt-2 text-foreground">
                      <Button size="sm" variant="outline" onClick={clear}>
                        清除筛选
                      </Button>
                    </div>
                  </>
                ) : (
                  '库里还没有任何任务。'
                )
              }
            />
          ) : (
            <List>
              <ListHeader showCost={showCost} />
              {rows.map((row) => (
                <Row key={row.taskId} row={row} from={from} now={now} showCost={showCost} />
              ))}
            </List>
          )}
          {rows.length > 0 ? (
            <div ref={sentinel} className="border-t p-2 text-center">
              {list.isFetchNextPageError ? (
                <LoadError what="下一页" error={list.error} onRetry={() => void list.fetchNextPage()} />
              ) : list.hasNextPage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage ? '正在读…' : '加载更多'}
                </Button>
              ) : (
                <span className="text-meta text-muted-foreground">
                  已经到底，共 <span className="num">{rows.length}</span> 张
                </span>
              )}
            </div>
          ) : null}
        </Section>
      </div>
    </Page>
  );
}
