// 任务列表页（/tasks，#1639；照路由页样板重做，#1919）：所有仓、所有状态的单子，最近更新在前。
// 顶上一排状态（带各自的数）、仓、搜索；筛选全写在地址栏（?status=&repo=&q=），刷新、返回都保得住。
// 一行一个主信息一个状态（规范第三节「行」）：标题一行，灰字一行（仓#单号、段、模型、PR），右边状态、花费、更新时间。
// 点一行进 /tasks/:taskId，链接带着 ?from=<这页的地址>，详情页左上的「返回」据此回到这里并带回筛选。
// 往下滚到底自动读下一页，也能点「加载更多」。从没读成写「没读成」和原因、给重试；读成过、刷新失败时留着上一次的列表，顶上横幅带重试；
// 筛出来是空的写「没有符合的任务」，不拿空列表冒充没有。

import { errMessage } from '@fleet-dao/shared/util';
import { ListChecks, SearchX } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
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
import { StatusBadge, StatusDot } from '../components/layout/status-badge';
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

/** 任务列表靠推送更新（tasks、runs 表一变就重拉），没有自己的轮询。超过 5 分钟还没再读成，刷新钮旁标「数据已过期」。 */
const TASKS_STALE_AFTER_MS = 5 * TIME.MIN;

/** 搜索框停下多久才去读。 */
const SEARCH_DEBOUNCE_MS = 300;

/** 页头一句说明；整段说明和这页上藏在悬停里的东西写在 ⓘ 里。 */
const DESCRIPTION = '所有仓的单子，最近有动静的在前';

const DETAIL = (
  <div className="space-y-2">
    <p>所有仓的单子，最近有动静的在前：在跑的、排队的、等人的，做完、失败、叫停的也都在。</p>
    <ul className="list-disc space-y-1 pl-4">
      <li>状态、仓、搜索都写在地址栏里，刷新、返回、复制链接都保得住。搜索：单号精确，标题包含。</li>
      <li>一行：标题；灰字是仓和单号、在哪一段、用的模型、PR；右边是状态、花费、最后有动静的时间。</li>
      <li>
        花费分实付和按 API 价折算的估计。订阅渠道没报花费时显示估计，不当成
        0；目录里没有单价的写「没有单价」，不写
        0。实付后面写「偏低」的：还有没算进来的。悬停看段数和读不到用量。整列都算不出时不画这一列。
      </li>
      <li>悬停时间看开单、更新的具体时刻。</li>
      <li>点一行进详情，详情页左上「任务列表」回来时筛选还在。往下滚到底自动读下一页。</li>
    </ul>
  </div>
);

/** 实付：新接口给 actual；没这个键的老响应退回 usd。 */
function paidOf(cost: TaskListRow['cost']): number | null {
  return cost.actual === undefined ? cost.usd : cost.actual;
}

/** 这一行有没有能画出来的花费（实付、估计、或「没有单价」）。只剩读不到用量的不单独占一列。 */
function costVisible(cost: TaskListRow['cost']): boolean {
  return paidOf(cost) !== null || (cost.estimated ?? null) !== null || (cost.noPrice ?? 0) > 0;
}

function Cost({ cost }: { cost: TaskListRow['cost'] }) {
  const paid = paidOf(cost);
  const estimated = cost.estimated ?? null;
  const segments = cost.segments ?? 0;
  const seg = segments > 0 ? <span data-segments>{` · ${segments} 段`}</span> : null;
  // 读不到留空：仍挂悬停说明，不写「没读到」（叫停、已结束的单同样；#1751）
  if (paid === null && estimated === null && (cost.noPrice ?? 0) === 0) {
    // 标准档位占位，留给悬停说明一块可指区域；不用任意值（lint-design R0 / #182）
    return <span className="inline-block size-4" title={cost.note} data-cost-empty />;
  }
  if (paid === null && estimated === null) {
    return (
      <span className="num text-ink-stall" title={cost.note} data-cost-noprice>
        没有单价
        {seg}
      </span>
    );
  }
  return (
    <span className="num" title={cost.note}>
      {paid !== null ? formatUsd(paid) : <span>{`估算 ${formatUsd(estimated ?? 0)}`}</span>}
      {paid !== null && cost.note?.includes('偏低') ? (
        <span className="whitespace-nowrap text-ink-stall"> 偏低</span>
      ) : null}
      {seg}
    </span>
  );
}

/**
 * 灰字一行的一项：前面带「·」分隔。分隔号跟着这一项藏：手机上第一项（仓#单号）藏了，第二项前面的分隔也藏，
 * 行首不留一个孤零零的点。
 */
interface MetaItem {
  key: string;
  node: ReactNode;
  /** 只在桌面（md 起）显示。 */
  desktop?: boolean;
  /** 只在手机上显示。 */
  phone?: boolean;
}

function MetaLine({ items }: { items: MetaItem[] }) {
  const shown = items.filter((i) => i.node !== null);
  return (
    <span
      data-row-meta
      className="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden text-meta whitespace-nowrap text-muted-foreground"
    >
      {shown.map((item, i) => {
        const hide = item.desktop ? 'max-md:hidden' : item.phone ? 'md:hidden' : undefined;
        // 这一项前面还有没有手机上看得见的：没有就把分隔号在手机上藏起来；桌面同理
        const phoneFirst = shown.slice(0, i).every((p) => p.desktop);
        const desktopFirst = shown.slice(0, i).every((p) => p.phone);
        const sepHide = cn(hide, phoneFirst && 'max-md:hidden', desktopFirst && 'md:hidden');
        return (
          <Fragment key={item.key}>
            {i > 0 ? (
              <span aria-hidden className={cn('shrink-0', sepHide)}>
                ·
              </span>
            ) : null}
            <span className={cn('min-w-0 truncate', i === 0 || item.key === 'model' ? '' : 'shrink-0', hide)}>
              {item.node}
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

/**
 * 一行（两行行高，规范「行」）：左边标题、下面一行灰字；右边一个状态，桌面再跟花费和更新时间两列（固定宽，上下对齐）。
 * 手机上右边只留状态，更新时间并进灰字行。开单时间在时间的悬停里。
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
  const when = formatAgo(row.updatedAt, now);
  const whenTitle = `开单 ${formatDateTime(row.createdAt)}；更新 ${formatDateTime(row.updatedAt)}`;
  return (
    <ListRow
      tall
      href={detailLink(row.taskId, from)}
      summary={
        <span className="flex w-full min-w-0 items-center gap-x-4">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-medium" title={row.title}>
              {row.title}
            </span>
            <MetaLine
              items={[
                {
                  key: 'repo',
                  desktop: true,
                  node: (
                    <span className="num">
                      {row.repo}#{row.issueNumber}
                    </span>
                  ),
                },
                { key: 'segment', node: row.segment === null ? null : segmentText[row.segment] },
                {
                  key: 'model',
                  node: (
                    <span title="用的模型">
                      {row.model ?? <span title="这张单还没有会话记录">没记模型</span>}
                    </span>
                  ),
                },
                {
                  key: 'pr',
                  node: row.prNumber === null ? null : <span className="num">PR #{row.prNumber}</span>,
                },
                {
                  key: 'request',
                  node:
                    row.requestSeq === undefined ? null : (
                      <span className="num" title="这张单是驾驶舱「提需求」开出来的" data-from-request>
                        来自需求 {row.requestSeq}
                      </span>
                    ),
                },
                {
                  key: 'when',
                  phone: true,
                  node: (
                    <span className="num" title={whenTitle}>
                      {when}
                    </span>
                  ),
                },
              ]}
            />
          </span>
          <span className="flex shrink-0 items-center md:w-28">
            <StatusBadge tone={status.tone} label={status.label} />
          </span>
          {showCost ? (
            <span
              className="w-40 shrink-0 whitespace-nowrap text-right text-body max-md:hidden"
              data-cost-col
              title={['花费', row.cost.note].filter(Boolean).join('；')}
            >
              <span className="sr-only">花费</span>
              <Cost cost={row.cost} />
            </span>
          ) : null}
          <span
            className="num w-20 shrink-0 text-right text-meta whitespace-nowrap text-muted-foreground max-md:hidden"
            title={whenTitle}
          >
            {when}
          </span>
        </span>
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

/**
 * 页头右上的一句汇总（照路由页样板）：在跑几个；排队、等人是 0 就不写。点是最该看的那个：有等人的画等人色，
 * 有在跑的画在跑色。失败、叫停是历史，不进这一句（页签上有数）。
 */
function Summary({ counts }: { counts: TaskList['counts'] }) {
  const tone = counts.waiting > 0 ? 'human' : counts.running > 0 ? 'run' : 'done';
  return (
    <p
      data-tasks-summary
      // 手机上不写：标题行放不下会折到第二行，各组的数页签上都有
      className="flex items-center gap-2 text-body whitespace-nowrap text-muted-foreground max-md:hidden"
      title="按状态页签上的数：全部仓、全部时间"
    >
      <StatusDot tone={tone} />
      <span className="num text-foreground">{counts.running} 个在跑</span>
      {counts.queued > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span className="num">{counts.queued} 个排队</span>
        </>
      ) : null}
      {counts.waiting > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span className="num font-medium text-ink-human">{counts.waiting} 个等人</span>
        </>
      ) : null}
    </p>
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
  // 只管「整页没读成」；已经有数据后读下一页失败，由列表底下那一条说；刷新失败由顶上横幅说
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
  // 已读到的行实付、估计、单价都没有：整列不画（#1902）。只有「读不到用量」的不单独把列撑出来。
  const showCost = rows.some((r) => costVisible(r.cost));
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
  // 读成过、这次刷新没读成：列表留着，顶上写明是上一次的
  const refreshFailed = Boolean(list.data) && list.isRefetchError;

  return (
    <Page
      title="任务"
      description={DESCRIPTION}
      detail={DETAIL}
      actions={counts ? <Summary counts={counts} /> : undefined}
      refresh={{
        onRefresh: () => void list.refetch(),
        isFetching: list.isFetching,
        dataUpdatedAt: list.dataUpdatedAt > now ? now : list.dataUpdatedAt,
        staleAfterMs: TASKS_STALE_AFTER_MS,
        variant: 'dot',
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
            // 手机上仓和搜索并排一行（各占一半），不再各占一整行
            <div className="flex w-full min-w-0 items-center gap-2 md:w-auto">
              <NativeSelect
                aria-label="按仓筛选"
                value={view.repoId ?? ''}
                onChange={(e) => setView({ ...view, repoId: e.target.value || undefined })}
                className="min-w-0 max-md:flex-1"
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
                className="min-w-0 max-md:flex-1 md:w-64"
              />
            </div>
          }
        />
        {shownError ? (
          <div className="mb-3">
            <LoadError what="任务列表" error={shownError} onRetry={() => void list.refetch()} />
          </div>
        ) : null}
        {refreshFailed ? (
          <div className="mb-3">
            <LoadError
              text={`任务列表刷新没读成，下面是上一次读到的：${errMessage(list.error)}`}
              error={list.error}
              onRetry={() => void list.refetch()}
            />
          </div>
        ) : null}
        {list.data?.pages[0]?.requestSeqUnavailable ? (
          <p className="mb-3 text-meta text-ink-stall" data-request-seq-unavailable>
            「来自需求 N」没查成：{list.data.pages[0].requestSeqUnavailable}
            （下面的单可能有从「提需求」开出来的）
          </p>
        ) : null}
        <Section flush>
          {!list.data ? (
            shownError ? (
              <EmptyState
                icon={ListChecks}
                title="没读到任务列表"
                hint="这里空着不代表没有任务，点上面的「重试」再读一次"
              />
            ) : (
              <div className="p-4">
                <LoadingRows rows={6} />
              </div>
            )
          ) : rows.length === 0 ? (
            <EmptyState
              icon={filtered ? SearchX : ListChecks}
              title="没有符合的任务"
              hint={filtered ? '换个状态、仓或搜索词试试。' : '库里还没有任何任务。'}
              action={
                filtered ? (
                  <Button size="sm" variant="outline" onClick={clear}>
                    清除筛选
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <List>
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
