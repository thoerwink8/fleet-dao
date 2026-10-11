import { Gauge, Info } from 'lucide-react';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { brand } from '#brand';
import { errorText, usePools } from '../api/client';
import type { PoolView, QuotaWindowKind, QuotaWindowView } from '../api/types';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { List, ListRow } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { Tag } from '../components/layout/tag';
import type { LayoutTone } from '../components/layout/tone';
import { PoolProblemLine, usePoolProblems } from '../components/pool-problem';
import { ExpiredQuotaLine, isExpiredWindow, QuotaLine, quotaValue, readingVerb } from '../components/quota';
import { QuotaNotice } from '../components/quota-notice';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import {
  billingLabel,
  isNearlyExhausted,
  isUpstreamFull,
  isUseItOrLoseIt,
  poolTitle,
  utilOf,
  windowLabel,
  windowRank,
  windowTitle,
} from '../lib/catalog';
import { formatAgo, formatDate, formatIn, formatInDays, formatPercent } from '../lib/format';
import { useNow } from '../lib/hooks';
import type { PoolProblem } from '../lib/pool-problems';
import { routeSlots } from '../lib/routing';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('额度') }];
}

/** 摘要面板：点上面的标签展开，一次只开一块。第一行是这一栏的说明，下面一行一项。 */
function SummaryPanel({ title, hint, items }: { title: string; hint: string; items: ReactNode[] }) {
  return (
    <Section flush data-quota-panel aria-label={title} className="mt-3">
      <p className="border-b px-4 py-2 text-meta text-muted-foreground">{hint}</p>
      {items.length ? <List>{items}</List> : <EmptyState size="inline" title="没有" />}
    </Section>
  );
}

type Cell = { pool: PoolView; w: QuotaWindowView };

/** 摘要卡里的名字：池名一行、窗口名一行，窄宽度换行，悬停看全文。不再单行截断。 */
function SummaryName({ pool, w }: { pool: PoolView; w?: QuotaWindowView }) {
  const poolName = poolTitle(pool);
  const win = w ? windowTitle(w) : undefined;
  const full = win ? `${poolName} · ${win}` : poolName;
  return (
    <span className="min-w-0 flex-1 break-words text-body" title={full}>
      <span className="block">{poolName}</span>
      {win ? <span className="block">{win}</span> : null}
    </span>
  );
}

export default function Quota() {
  const { data, error, isLoading, refetch, isFetching, dataUpdatedAt } = usePools();
  const now = useNow();
  const poolProblems = usePoolProblems();
  const [openId, setOpenId] = useState<string | undefined>();
  const staleMinutes = data?.staleAfterMinutes ?? 30;
  const refresh = {
    onRefresh: () => void refetch(),
    isFetching,
    dataUpdatedAt,
    staleAfterMs: staleMinutes * 60_000,
  };

  if (error) {
    return (
      <Page title="额度" refresh={refresh}>
        <LoadError error={error} />
      </Page>
    );
  }

  const pools = data?.pools ?? [];
  const cells: Cell[] = pools.flatMap((pool) => pool.windows.map((w) => ({ pool, w })));
  const key = ({ pool, w }: Cell, i: number) => `${pool.id}-${w.window}-${i}`;
  const hot = cells.flatMap((c) => {
    const util = utilOf(c.w);
    return !c.w.stale && util !== undefined && isUseItOrLoseIt(c.w, now) ? [{ ...c, util }] : [];
  });
  const full = cells.filter(({ w }) => isNearlyExhausted(w));
  // 有提醒说读不到、凭据过期的池（#1748）：原因和要人做什么写在这一栏，它的旧窗口不再逐个列一遍（同一个池只出现一次）
  const problems = poolProblems.problems;
  const withProblem = pools.filter((p) => problems.has(p.id));
  const stale = cells.filter(({ pool, w }) => w.stale && !problems.has(pool.id));
  // 读成了但没有用量比例（只报了清零时间，或只有已用没有上限）：不参与「先用它」和排序，但要列出来。
  const unknownUse = cells.filter(
    ({ w }) => !w.stale && !w.staleSince && !isUpstreamFull(w) && utilOf(w) === undefined,
  );
  // 读成过、但上游这次没再报：数是之前的，照样列出来。
  const unreported = cells.filter(({ w }) => !w.stale && w.staleSince);
  const unread = pools.filter((p) => p.quotaStatus === 'unread' && !problems.has(p.id));
  const kinds = [...new Set(cells.map(({ w }) => w.window))].sort((a, b) => windowRank[a] - windowRank[b]);

  const summaries: {
    id: string;
    title: string;
    hint: string;
    tone: LayoutTone | undefined;
    items: ReactNode[];
  }[] = [
    {
      id: 'hot',
      title: '先用它',
      hint: '快清零了还剩不少，不用就浪费',
      tone: undefined,
      items: hot.map((c, i) => (
        <ListRow
          key={key(c, i)}
          summary={
            <>
              <SummaryName pool={c.pool} w={c.w} />
              <span className="num shrink-0 text-body text-muted-foreground">
                剩 {formatPercent(1 - c.util)}
              </span>
              {c.w.resetsAt ? (
                <span className="num shrink-0 text-meta">{formatIn(c.w.resetsAt, now)}</span>
              ) : null}
            </>
          }
        />
      )),
    },
    {
      id: 'full',
      title: '快用完',
      hint: '用了九成以上，调度会先绕开',
      tone: 'fail',
      items: full.map((c, i) => (
        <ListRow
          key={key(c, i)}
          summary={
            <>
              <SummaryName pool={c.pool} w={c.w} />
              <span className="num shrink-0 text-body text-ink-fail">{quotaValue(c.w)}</span>
            </>
          }
        />
      )),
    },
    {
      id: 'stale',
      title: '读数过期或没查成',
      hint: `超过 ${staleMinutes} 分钟没读到新数的不能当现值用；一条都没读到的是「没查成」，不是「没用量」；只读到清零时间的是「用量没读到」`,
      tone: 'stall',
      items: [
        ...withProblem.map((p) => (
          <ListRow
            key={`problem-${p.id}`}
            summary={
              <div className="min-w-0 flex-1">
                <SummaryName pool={p} />
                <PoolProblemLine problem={problems.get(p.id) as PoolProblem} now={now} className="mt-0.5" />
              </div>
            }
          />
        )),
        ...unread.map((p) => (
          <ListRow
            key={`unread-${p.id}`}
            summary={
              <>
                <SummaryName pool={p} />
                <span className="shrink-0 text-body text-ink-stall">没查成</span>
              </>
            }
          />
        )),
        ...unknownUse.map((c, i) => (
          <ListRow
            key={`unknown-${key(c, i)}`}
            summary={
              <>
                <SummaryName pool={c.pool} w={c.w} />
                <span className="shrink-0 text-body text-ink-stall">{quotaValue(c.w)}</span>
              </>
            }
          />
        )),
        ...unreported.map((c, i) => (
          <ListRow
            key={`unreported-${key(c, i)}`}
            summary={
              <>
                <SummaryName pool={c.pool} w={c.w} />
                <span className="shrink-0 text-body text-ink-stall">上游这次没报</span>
              </>
            }
          />
        )),
        ...stale.map((c, i) => (
          <ListRow
            key={key(c, i)}
            summary={
              <>
                <SummaryName pool={c.pool} w={c.w} />
                <span className="num shrink-0 text-body text-ink-stall">
                  {formatAgo(c.w.readAt, now)}
                  {readingVerb(c.w.reading)}
                </span>
              </>
            }
          />
        )),
      ],
    },
  ];
  const openSummary = summaries.find((x) => x.id === openId);

  return (
    <Page
      title="额度"
      description="每个账号池、每个时间窗：用了多少、几点清零，每个数都写明是实读还是估算。快清零还剩不少的会高亮——调度会先用它。"
      refresh={refresh}
    >
      {isLoading || !data ? (
        <LoadingRows rows={6} />
      ) : (
        <>
          <QuotaNotice orgSwitch={data.orgSwitch} reconcile={data.carpoolReconcile} />
          {/* 三个标签排一行，点哪个展开哪个的明细（一次只开一块，再点一下收起）。 */}
          <div data-quota-summary>
            <FilterTabs
              mode="toggle"
              aria-label="额度摘要"
              items={summaries.map((x) => ({
                id: x.id,
                label: x.title,
                count: x.items.length,
                ...(x.items.length > 0 && x.tone ? { tone: x.tone } : {}),
              }))}
              value={openId}
              onChange={(id) => setOpenId((cur) => (cur === id ? undefined : id))}
            />
            {openSummary ? (
              <SummaryPanel title={openSummary.title} hint={openSummary.hint} items={openSummary.items} />
            ) : null}
          </div>

          {pools.length === 0 ? (
            <Section>
              <EmptyState icon={Gauge} title="还没有账号池" />
            </Section>
          ) : (
            <Matrix pools={pools} kinds={kinds} now={now} problems={problems} />
          )}
          {poolProblems.error ? (
            <p data-pool-problems="unreadable" className="mt-2 text-meta text-ink-stall">
              账号池的毛病（额度读不到、凭据过期）没读成：{errorText(poolProblems.error)}
              。表里没写不代表没有。
            </p>
          ) : null}
        </>
      )}
    </Page>
  );
}

/** 表头里的 ⓘ：实读和估算是什么意思（原来是表上面一条灰色图例）。窄屏表头藏起来，每格点开的说明里有同样的读法。 */
function LegendHint() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="实读和估算是什么意思"
          data-quota-legend
          className="inline-grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-focus focus-visible:ring-ring focus-visible:outline-none"
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-xs space-y-1.5 text-body text-muted-foreground">
        <p>实读：从官方接口或它自家网页的用量接口读到的。</p>
        <p>估算：读不到，按我们自己的用量算，撞到限额时记下上限。</p>
      </PopoverContent>
    </Popover>
  );
}

/** 一个池一行：宽屏窗口按类对齐成列，窄屏每个池一张卡、窗口两列排，都不横向滚动（见 app.css 的 .quota-*）。 */
function Matrix({
  pools,
  kinds,
  now,
  problems,
}: {
  pools: PoolView[];
  kinds: QuotaWindowKind[];
  now: number;
  problems: ReadonlyMap<string, PoolProblem>;
}) {
  const channels = [...new Map(pools.map((p) => [p.channelId, p])).values()];
  const cols = { '--quota-kinds': kinds.length } as CSSProperties;
  return (
    <div className="quota-matrix" data-quota-matrix>
      <Section flush>
        {/* 真表格元素，样式里改成块 / 网格布局（.quota-matrix :where(...)），读屏照样按表读。 */}
        <table className="w-full text-left">
          <caption className="sr-only">每个账号池、每个时间窗的额度</caption>
          <thead>
            <tr
              className="quota-head border-b bg-muted px-4 py-1.5 text-meta text-muted-foreground"
              style={cols}
            >
              <th scope="col" className="font-normal">
                <span className="inline-flex items-center gap-1">
                  账号池
                  <LegendHint />
                </span>
              </th>
              {kinds.map((k) => (
                <th scope="col" key={k} className="font-normal">
                  {windowLabel[k]}
                </th>
              ))}
            </tr>
          </thead>
          {channels.map((ch) => {
            const list = pools.filter((p) => p.channelId === ch.channelId);
            return (
              <tbody key={ch.channelId}>
                <tr>
                  <th scope="colgroup" className="border-b bg-background px-4 py-1 text-meta font-normal">
                    <span className="flex items-center gap-2">
                      <span className="font-semibold">{ch.channelName}</span>
                      <Tag>{ch.billing ? billingLabel[ch.billing] : '计费未知'}</Tag>
                      {ch.channelEnabled ? null : <span className="text-muted-foreground">已下架</span>}
                    </span>
                  </th>
                </tr>
                {list.map((p) => (
                  <tr
                    key={p.id}
                    className="quota-pool border-b px-4 py-2 last:border-b-0"
                    style={cols}
                    data-pool={p.id}
                  >
                    <th scope="row" className="quota-pool-head min-w-0 font-normal">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="num text-body font-medium">{p.id}</span>
                        <span className="text-meta text-muted-foreground">
                          {
                            routeSlots({
                              inFlight: p.running,
                              reserved: p.reserved,
                              maxConcurrency: p.maxConcurrency,
                            }).text
                          }
                        </span>
                        {p.windows.length === 0 ? (
                          <span
                            data-quota-empty
                            className={cn(
                              'text-meta',
                              p.quotaStatus === 'unread' ? 'text-ink-stall' : 'text-muted-foreground',
                            )}
                          >
                            {p.quotaStatus === 'unread' ? '没查成' : '无额度窗'}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-meta text-muted-foreground">
                        {p.expiresAt ? (
                          <>
                            <span className="num">{formatDate(p.expiresAt)}</span> 到期 ·{' '}
                            <span className="num">{formatInDays(p.expiresAt, now)}</span>
                          </>
                        ) : (
                          '没有到期日'
                        )}
                      </div>
                      {problems.has(p.id) ? (
                        <PoolProblemLine
                          problem={problems.get(p.id) as PoolProblem}
                          className="mt-1 font-normal"
                        />
                      ) : null}
                    </th>
                    {/* 没有任何额度窗的池只画名字这一行，不再补一排「—」。 */}
                    {(p.windows.length === 0 ? [] : kinds).map((k) => {
                      const ws = p.windows.filter((x) => x.window === k);
                      // 同一池同一类窗有新旧两张时：过期的收成一行灰字，不与新读数并排占大格
                      const expired = ws.filter((w) => isExpiredWindow(w, now));
                      const current = ws.filter((w) => !isExpiredWindow(w, now));
                      const collapseExpired = expired.length > 0 && current.length > 0;
                      const showFull = collapseExpired ? current : ws;
                      if (ws.length === 0) {
                        return (
                          <td
                            key={k}
                            className={cn(
                              'quota-cell-empty text-meta',
                              p.quotaStatus === 'unread' ? 'text-ink-stall' : 'text-muted-foreground',
                            )}
                          >
                            {p.quotaStatus === 'unread' ? '没查成' : '—'}
                          </td>
                        );
                      }
                      return (
                        <td key={k} className="min-w-0 space-y-1">
                          {showFull.map((w, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: 同一种窗可能有好几个（按模型组），契约里没有区分它们的字段。
                            <QuotaLine key={i} w={w} now={now} />
                          ))}
                          {collapseExpired
                            ? expired.map((_, i) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: 同上，过期旧读数没有稳定主键。
                                <ExpiredQuotaLine key={`expired-${i}`} />
                              ))
                            : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </Section>
    </div>
  );
}
