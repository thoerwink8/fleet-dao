// 任务列表页（/tasks，#1639；#3509 照 Arco 改版，样稿 canvas/Tasks.dc.html）：所有仓、所有状态的单子，最近更新在前。
// 两张卡：筛选卡（状态页签带各自的数、仓、搜索、读失败/刷新没成/缺一块的提示条）和列表卡（flush，一行一张单）。
// 筛选全写在地址栏（?status=&repo=&q=），刷新、返回都保得住。
// 一行一个主信息一个状态（规范第三节「行」）：标题一行，灰字一行（仓#单号、段、模型、PR、来自需求），右边状态、花费、更新时间。
// 点一行进 /tasks/:taskId，链接带着 ?from=<这页的地址>，详情页左上的「返回」据此回到这里并带回筛选。
// 往下滚到底自动读下一页，也能点「加载更多」。数据的五种样子（lib/query-view.ts）：
// 从没读成 → 红提示条加重试，列表卡不画；读成过、刷新没成 → 照旧画上一次的列表，顶上橙条「刷新没成，下面是 N 分钟前读到的」加重试；
// 筛出来是空的写「没有符合的任务」，不拿空列表冒充没有。
// 「只看卡住的」没做：列表接口的行目前没有「出问题」字段，不造假数据；等接口给每行一个出问题标记（和工作台在跑表同一判法）再加。

import { ListChecks, SearchX } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useRepos, useTaskList } from '../api/client';
import type { TaskList, TaskListRow } from '../api/types';
import { FlowModeTag } from '../components/flow-mode-tag';
import { Button } from '../components/layout/button';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { List, ListRow } from '../components/layout/list';
import { ListFooter } from '../components/layout/list-footer';
import { LoadError, LoadingRows, LoadPartial, LoadStale } from '../components/layout/load-state';
import { MetaLine } from '../components/layout/meta-line';
import { NativeSelect } from '../components/layout/native-select';
import { Page } from '../components/layout/page';
import { SearchInput } from '../components/layout/search-input';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { LevelDot, StatusBadge } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { formatAgo, formatDateTime, formatUsd, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { type QueryView, viewOf } from '../lib/query-view';
import { useShownError } from '../lib/shown-error';
import {
  dedupeRows,
  detailLink,
  filterOf,
  GROUP_TABS,
  isFiltered,
  listLocation,
  paramsWithView,
  rowStatusKey,
  segmentText,
  type TaskListView,
  viewOfParams,
} from '../lib/task-list';
import { usePhone } from '../lib/viewport';

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
  <Stack gap="sm">
    <Text as="p">所有仓的单子，最近有动静的在前：在跑的、排队的、等人的，做完、失败、叫停的也都在。</Text>
    <Text as="p">状态、仓、搜索都写在地址栏里，刷新、返回、复制链接都保得住。搜索：单号精确，标题包含。</Text>
    <Text as="p">
      一行：标题；灰字是仓和单号、在哪一段、用的模型、PR；右边是状态、花费、最后有动静的时间。
    </Text>
    <Text as="p">
      花费分实付和按 API 价折算的估计。订阅渠道没报花费时显示估计，不当成
      0；目录里没有单价的写「没有单价」，不写
      0。实付后面写「偏低」的：还有没算进来的。悬停看段数和读不到用量。整列都算不出时不画这一列。
    </Text>
    <Text as="p">悬停时间看开单、更新的具体时刻。</Text>
    <Text as="p">点一行进详情，详情页左上「任务列表」回来时筛选还在。往下滚到底自动读下一页。</Text>
  </Stack>
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
  const seg =
    segments > 0 ? (
      <span data-segments>
        <Text tone="muted">{` · ${segments} 段`}</Text>
      </span>
    ) : null;
  // 读不到留空：仍挂悬停说明，不写「没读到」（叫停、已结束的单同样；#1751）
  if (paid === null && estimated === null && (cost.noPrice ?? 0) === 0) {
    // 标准档位占位，留给悬停说明一块可指区域
    return <span className="inline-block size-4" title={cost.note} data-cost-empty />;
  }
  if (paid === null && estimated === null) {
    return (
      <span className="num" title={cost.note} data-cost-noprice>
        <Text tone="warning">没有单价</Text>
        {seg}
      </span>
    );
  }
  return (
    <span className="num" title={cost.note}>
      <Text>{paid !== null ? formatUsd(paid) : `估算 ${formatUsd(estimated ?? 0)}`}</Text>
      {seg}
      {paid !== null && cost.note?.includes('偏低') ? (
        <>
          {' '}
          <span title="还有没算进来的，实际可能更高">
            <Tag tone="warning">偏低</Tag>
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * 一行（两行行高，规范「行」）：左边标题、下面一行灰字；右边一个状态，桌面再跟花费和更新时间两列（固定宽，上下对齐）。
 * 手机上右边只留状态，更新时间并进灰字行，仓#单号藏起。开单时间在时间的悬停里。
 */
function Row({
  row,
  from,
  now,
  showCost,
  phone,
}: {
  row: TaskListRow;
  from: string;
  now: number;
  showCost: boolean;
  phone: boolean;
}) {
  const when = formatAgo(row.updatedAt, now);
  const whenTitle = `开单 ${formatDateTime(row.createdAt)}；更新 ${formatDateTime(row.updatedAt)}`;
  const metaItems: ReactNode[] = [
    phone ? null : (
      <span key="repo" className="num">
        {row.repo}#{row.issueNumber}
      </span>
    ),
    row.segment === null ? null : segmentText[row.segment],
    <span key="model" title="用的模型">
      {row.model ?? <span title="这张单还没有会话记录">没记模型</span>}
    </span>,
    row.prNumber === null ? null : (
      <span key="pr" className="num">
        PR #{row.prNumber}
      </span>
    ),
    row.requestSeq === undefined ? null : (
      <span key="request" className="num" title="这张单是驾驶舱「提需求」开出来的" data-from-request>
        来自需求 {row.requestSeq}
      </span>
    ),
    phone ? (
      <span key="when" className="num" title={whenTitle}>
        {when}
      </span>
    ) : null,
  ];
  return (
    <ListRow
      tall
      href={detailLink(row.taskId, from)}
      summary={
        <>
          <span className="block min-w-0 flex-1">
            <Stack direction="horizontal" gap="sm" align="center">
              <Text strong truncate title={row.title}>
                {row.title}
              </Text>
              <FlowModeTag mode={row.flowMode} fallback={row.flowFallback} />
            </Stack>
            <span data-row-meta className="block min-w-0 truncate whitespace-nowrap">
              <MetaLine items={metaItems} className="flex-nowrap overflow-hidden" />
            </span>
          </span>
          <span className="shrink-0 md:w-28">
            <StatusBadge status={rowStatusKey(row)} variant="dot" />
          </span>
          {showCost ? (
            <span
              className="w-40 shrink-0 text-right whitespace-nowrap max-md:hidden"
              data-cost-col
              title={['花费', row.cost.note].filter(Boolean).join('；')}
            >
              <span className="sr-only">花费</span>
              <Cost cost={row.cost} />
            </span>
          ) : null}
          <span className="num w-20 shrink-0 text-right whitespace-nowrap max-md:hidden" title={whenTitle}>
            <Text size="meta" tone="secondary">
              {when}
            </Text>
          </span>
        </>
      }
    />
  );
}

/**
 * 页头右上的一句汇总（照路由页样板）：在跑几个；排队、等人是 0 就不写。点是最该看的那个：有等人的画等人，有在跑的画在跑。
 * 失败、叫停是历史，不进这一句（页签上有数）。
 */
function Summary({ counts }: { counts: TaskList['counts'] }) {
  const level = counts.waiting > 0 ? 'default' : counts.running > 0 ? 'processing' : 'success';
  return (
    <span
      data-tasks-summary
      // 手机上不写：标题行放不下会折到第二行，各组的数页签上都有
      className="max-md:hidden"
      title="按状态页签上的数：全部仓、全部时间"
    >
      <Stack direction="horizontal" gap="sm" align="center">
        <LevelDot level={level} />
        <Text tone="secondary">
          <span className="num">{counts.running} 个在跑</span>
        </Text>
        {counts.queued > 0 ? (
          <Text tone="secondary">
            · <span className="num">{counts.queued} 个排队</span>
          </Text>
        ) : null}
        {counts.waiting > 0 ? (
          <Text tone="secondary" strong>
            · <span className="num">{counts.waiting} 个等人</span>
          </Text>
        ) : null}
      </Stack>
    </span>
  );
}

/** 滚到列表底下就读下一页；没有 IntersectionObserver 的环境（测试）只靠「加载更多」按钮。 */
function useLoadMoreOnScroll(enabled: boolean, load: () => void) {
  const ref = useRef<HTMLSpanElement>(null);
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
  // 读下一页失败由列表底下那一条说，不算整页的刷新失败；读成过、刷新失败是 stale（留着上一次的列表），从没读成才是 error
  const base = viewOf({
    error: list.isFetchNextPageError ? null : list.error,
    data: list.data,
    dataUpdatedAt: list.dataUpdatedAt,
    refetch: list.refetch,
  });
  // 推送重读会把从没读成过的查询退回骨架：显示记住的那次失败
  const shownError = useShownError(JSON.stringify(filter), {
    error: list.data ? null : list.error,
    data: list.data,
  });
  const state: QueryView<typeof list.data> =
    base.status === 'loading' && shownError
      ? { status: 'error', error: shownError, retry: () => void list.refetch() }
      : base;
  const repos = useRepos();
  const now = useNow();
  const phone = usePhone();

  const setView = (next: TaskListView) => setParams((prev) => paramsWithView(prev, next), { replace: true });

  // 搜索框：打字先记在本地，停下 300 毫秒再写进地址栏（每敲一个字都去读，后端白忙）。地址栏被别处改了（返回、清除筛选）就跟着变。
  const [typed, setTyped] = useState(view.q);
  useEffect(() => setTyped(view.q), [view.q]);
  useEffect(() => {
    if (typed === view.q) return;
    const timer = setTimeout(() => setView({ ...view, q: typed }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  const rows = useMemo(() => (list.data ? dedupeRows(list.data.pages) : null), [list.data]);
  // 已读到的行实付、估计、单价都没有：整列不画（#1902）。只有「读不到用量」的不单独把列撑出来。
  const showCost = rows !== null && rows.some((r) => costVisible(r.cost));
  const firstPage = list.data ? list.data.pages[0] : undefined;
  const counts = firstPage ? firstPage.counts : undefined;
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
        <Stack>
          <Section>
            <Stack gap="md">
              <FilterTabs
                aria-label="按状态"
                idPrefix="tasks"
                items={GROUP_TABS.map((tab) => ({
                  id: tab.id,
                  label: tab.label,
                  ...(counts ? { count: counts[tab.id] } : {}),
                }))}
                value={view.status ?? 'all'}
                onChange={(id) => setView({ ...view, status: id === 'all' ? undefined : id })}
              />
              <Stack direction="horizontal" gap="md" align="center" wrap>
                <NativeSelect
                  aria-label="按仓筛选"
                  value={view.repoId ?? ''}
                  onChange={(e) => setView({ ...view, repoId: e.target.value || undefined })}
                  className="min-w-0 max-md:flex-1"
                >
                  <option value="">全部仓</option>
                  {repos.data
                    ? repos.data.repos.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.owner}/{r.name}
                        </option>
                      ))
                    : null}
                </NativeSelect>
                <SearchInput
                  value={typed}
                  onChange={setTyped}
                  placeholder="搜单号或标题"
                  aria-label="搜索任务：单号精确，标题包含"
                  className="min-w-0 max-md:flex-1 md:w-64"
                />
              </Stack>
              {state.status === 'error' ? (
                <LoadError what="任务列表" error={state.error} onRetry={state.retry} />
              ) : null}
              {state.status === 'data' && state.stale ? (
                <LoadStale what="任务列表" stale={state.stale} staleAfterMs={TASKS_STALE_AFTER_MS} />
              ) : null}
              {firstPage?.requestSeqUnavailable ? (
                <LoadPartial>
                  <span data-request-seq-unavailable>
                    「来自需求 N」没查成：{firstPage.requestSeqUnavailable}
                    （下面的单可能有从「提需求」开出来的）
                  </span>
                </LoadPartial>
              ) : null}
            </Stack>
          </Section>
          {state.status === 'loading' ? (
            <Section>
              <LoadingRows rows={6} />
            </Section>
          ) : null}
          {state.status === 'data' && rows ? (
            <Section flush role="tabpanel" id="tasks-panel" aria-label="任务列表">
              {rows.length === 0 ? (
                <EmptyState
                  icon={filtered ? SearchX : ListChecks}
                  title="没有符合的任务"
                  hint={filtered ? '换个状态、仓或搜索词试试。' : '库里还没有任何任务。'}
                  action={
                    filtered ? (
                      <Button variant="secondary" onClick={clear}>
                        清除筛选
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <List>
                    {rows.map((row) => (
                      <Row
                        key={row.taskId}
                        row={row}
                        from={from}
                        now={now}
                        showCost={showCost}
                        phone={phone}
                      />
                    ))}
                  </List>
                  <ListFooter>
                    <span ref={sentinel} aria-hidden className="inline-block size-px" />
                    {list.isFetchNextPageError ? (
                      <LoadError what="下一页" error={list.error} onRetry={() => void list.fetchNextPage()} />
                    ) : list.hasNextPage ? (
                      <Button
                        size="sm"
                        onClick={() => void list.fetchNextPage()}
                        {...(list.isFetchingNextPage ? { disabledReason: '正在读下一页' } : {})}
                      >
                        {list.isFetchingNextPage ? '正在读…' : '加载更多'}
                      </Button>
                    ) : (
                      <Text size="meta" tone="muted">
                        已经到底，共 <span className="num">{rows.length}</span> 张
                      </Text>
                    )}
                  </ListFooter>
                </>
              )}
            </Section>
          ) : null}
        </Stack>
      </div>
    </Page>
  );
}
