// 任务列表页（/tasks，#1639）：所有仓、所有状态的单子，最近更新在前。
// 顶上一排状态（带各自的数）、仓、搜索；筛选全写在地址栏（?status=&repo=&q=），刷新、返回都保得住。
// 点一行进 /tasks/:taskId，链接带着 ?from=<这页的地址>，详情页左上的「返回」据此回到这里并带回筛选。
// 往下滚到底自动读下一页，也能点「加载更多」。读不到写「没读成」和原因、给重试；筛出来是空的写「没有符合的任务」，不拿空列表冒充没有。
// 手机宽度一行是一张卡片，md 起是十二栏的表格行。

import { ListChecks, Search, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useRepos, useTaskList } from '../api/client';
import type { TaskList, TaskListRow } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { StatusChip } from '../components/status';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
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
    // 标准档位占位，留给悬停说明一块可指区域；不用任意值（lint-arbitrary / #182）
    return <span className="inline-block size-4" title={cost.note} data-cost-empty />;
  }
  return (
    <span className="num" title={cost.note}>
      {formatUsd(cost.usd)}
      {cost.note ? <span className="whitespace-nowrap text-ink-stall"> 偏低</span> : null}
    </span>
  );
}

/** 桌面十二栏表头：和 Row 同一套 col-span，手机上不画（每行卡片自己带上下文）。 */
function ListHeader() {
  return (
    <li
      className="hidden border-b px-4 py-2 text-caption text-muted-foreground md:grid md:grid-cols-12 md:items-center md:gap-x-4"
      aria-hidden
      data-list-header
    >
      <span className="md:col-span-4">单</span>
      <span className="md:col-span-2">状态</span>
      <span className="md:col-span-2">模型</span>
      <span className="text-right md:col-span-2">花费</span>
      <span className="text-right md:col-span-2">更新</span>
    </li>
  );
}

function Row({ row, from, now }: { row: TaskListRow; from: string; now: number }) {
  const status = rowStatus(row);
  return (
    <li>
      <Link
        to={detailLink(row.taskId, from)}
        className="grid gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none md:grid-cols-12 md:items-center"
      >
        <div className="min-w-0 md:col-span-4">
          <div className="truncate text-sm font-medium">{row.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-caption text-muted-foreground">
            <span className="num">
              {row.repo}#{row.issueNumber}
            </span>
            <span className="num" title={formatDateTime(row.createdAt)}>
              开单 {formatAgo(row.createdAt, now)}
            </span>
          </div>
        </div>
        {/* 手机上这四样排成一两行；md 起各自占一栏（contents 让它们直接成为外层十二栏网格的格子） */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 md:contents">
          <div className="flex min-w-0 items-center gap-x-2 md:col-span-2">
            <StatusChip tone={status.tone} label={status.label} />
            {row.segment === null ? null : (
              <span className="text-caption whitespace-nowrap text-muted-foreground">
                {segmentText[row.segment]}
              </span>
            )}
          </div>
          <div className="min-w-0 truncate text-sub text-muted-foreground md:col-span-2" title="用的模型">
            {row.model ?? <span title="这张单还没有会话记录">没记模型</span>}
          </div>
          <div className="text-sub md:col-span-2 md:text-right">
            <Cost cost={row.cost} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 text-caption text-muted-foreground md:col-span-2 md:justify-end">
            {row.prNumber === null ? null : <span className="num">PR #{row.prNumber}</span>}
            <span className="num whitespace-nowrap" title={formatDateTime(row.updatedAt)}>
              更新 {formatAgo(row.updatedAt, now)}
            </span>
          </div>
        </div>
      </Link>
    </li>
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
    <div
      className="flex max-w-full overflow-x-auto rounded-lg bg-muted p-1"
      role="tablist"
      aria-label="按状态"
    >
      {GROUP_TABS.map((tab) => {
        const selected = (value ?? 'all') === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id === 'all' ? undefined : tab.id)}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-sub text-muted-foreground transition-colors',
              selected ? 'bg-card font-medium text-foreground shadow-sm' : 'hover:text-foreground',
            )}
          >
            {tab.label}
            {counts ? <span className="num text-caption">{counts[tab.id]}</span> : null}
          </button>
        );
      })}
    </div>
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
      actions={
        <RefreshBar
          onRefresh={() => void list.refetch()}
          isFetching={list.isFetching}
          dataUpdatedAt={list.dataUpdatedAt > now ? now : list.dataUpdatedAt}
          staleAfterMs={TASKS_STALE_AFTER_MS}
        />
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusTabs value={view.status} counts={counts} onChange={(status) => setView({ ...view, status })} />
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
          <select
            aria-label="按仓筛选"
            value={view.repoId ?? ''}
            onChange={(e) => setView({ ...view, repoId: e.target.value || undefined })}
            className="min-h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm sm:flex-none"
          >
            <option value="">全部仓</option>
            {(repos.data?.repos ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
              </option>
            ))}
          </select>
          <div className="relative w-full sm:w-64">
            <Search
              className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="搜单号或标题"
              className="pl-8"
              aria-label="搜索任务：单号精确，标题包含"
            />
          </div>
        </div>
      </div>
      {shownError ? (
        <div className="mb-3">
          <LoadError what="任务列表" error={shownError} onRetry={() => void list.refetch()} />
        </div>
      ) : null}
      <Panel bodyClassName="p-0">
        {!list.data ? (
          shownError ? (
            <p className="px-4 py-10 text-center text-sm text-ink-fail">
              没读到任务列表，这里空着不代表没有任务
            </p>
          ) : (
            <div className="p-4">
              <LoadingRows rows={6} />
            </div>
          )
        ) : rows.length === 0 ? (
          <Empty
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
          <ul className="divide-y">
            <ListHeader />
            {rows.map((row) => (
              <Row key={row.taskId} row={row} from={from} now={now} />
            ))}
          </ul>
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
              <span className="text-caption text-muted-foreground">
                已经到底，共 <span className="num">{rows.length}</span> 张
              </span>
            )}
          </div>
        ) : null}
      </Panel>
    </Page>
  );
}
