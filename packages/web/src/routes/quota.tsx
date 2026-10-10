import type { LucideIcon } from 'lucide-react';
import { Flame, Gauge, TimerOff, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { brand } from '#brand';
import { errorText, usePools } from '../api/client';
import type { PoolView, QuotaWindowKind, QuotaWindowView } from '../api/types';
import { CarpoolReconcileBanner } from '../components/carpool-reconcile';
import { OrgSwitchBanner } from '../components/org-switch';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { PoolProblemLine, usePoolProblems } from '../components/pool-problem';
import { ExpiredQuotaLine, isExpiredWindow, QuotaCell, quotaValue, readingVerb } from '../components/quota';
import { RefreshBar } from '../components/refresh-bar';
import { Badge } from '../components/ui/badge';
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

function Callout({
  icon: Icon,
  title,
  hint,
  items,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  items: ReactNode[];
  tone: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className={cn('size-4', tone)} aria-hidden />
        <span className="text-sm font-semibold">{title}</span>
        <span className="num ml-auto text-sm text-muted-foreground">{items.length}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      {items.length ? (
        <ul className="mt-3 space-y-1.5 text-sub">{items}</ul>
      ) : (
        <p className="mt-3 text-sub text-muted-foreground">没有</p>
      )}
    </div>
  );
}

type Cell = { pool: PoolView; w: QuotaWindowView };

/** 摘要卡里的名字：池名一行、窗口名一行，窄宽度换行，悬停看全文。不再单行截断。 */
function SummaryName({ pool, w }: { pool: PoolView; w?: QuotaWindowView }) {
  const poolName = poolTitle(pool);
  const win = w ? windowTitle(w) : undefined;
  const full = win ? `${poolName} · ${win}` : poolName;
  return (
    <span className="min-w-0 flex-1 break-words" title={full}>
      <span className="block">{poolName}</span>
      {win ? <span className="block">{win}</span> : null}
    </span>
  );
}

export default function Quota() {
  const { data, error, isLoading, refetch, isFetching, dataUpdatedAt } = usePools();
  const now = useNow();
  const poolProblems = usePoolProblems();
  const staleMinutes = data?.staleAfterMinutes ?? 30;
  const refresh = (
    <RefreshBar
      onRefresh={() => void refetch()}
      isFetching={isFetching}
      dataUpdatedAt={dataUpdatedAt}
      staleAfterMs={staleMinutes * 60_000}
    />
  );

  if (error) {
    return (
      <Page title="额度" actions={refresh}>
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

  return (
    <Page
      title="额度"
      description="每个账号池、每个时间窗：用了多少、几点清零，每个数都写明是实读还是估算。快清零还剩不少的会高亮——调度会先用它。"
      actions={refresh}
    >
      {isLoading || !data ? (
        <LoadingRows rows={6} />
      ) : (
        <>
          <OrgSwitchBanner view={data.orgSwitch} />
          <CarpoolReconcileBanner view={data.carpoolReconcile} />
          <div className="grid gap-3 md:grid-cols-3">
            <Callout
              icon={Flame}
              title="先用它"
              hint="快清零了还剩不少，不用就浪费"
              tone="text-foreground"
              items={hot.map((c, i) => (
                <li key={key(c, i)} className="flex items-start gap-2">
                  <SummaryName pool={c.pool} w={c.w} />
                  <span className="num shrink-0 text-muted-foreground">剩 {formatPercent(1 - c.util)}</span>
                  {c.w.resetsAt ? (
                    <span className="num shrink-0 text-xs">{formatIn(c.w.resetsAt, now)}</span>
                  ) : null}
                </li>
              ))}
            />
            <Callout
              icon={TriangleAlert}
              title="快用完"
              hint="用了九成以上，调度会先绕开"
              tone="text-ink-fail"
              items={full.map((c, i) => (
                <li key={key(c, i)} className="flex items-start gap-2">
                  <SummaryName pool={c.pool} w={c.w} />
                  <span className="num shrink-0 text-ink-fail">{quotaValue(c.w)}</span>
                </li>
              ))}
            />
            <Callout
              icon={TimerOff}
              title="读数过期或没查成"
              hint={`超过 ${staleMinutes} 分钟没读到新数的不能当现值用；一条都没读到的是「没查成」，不是「没用量」；只读到清零时间的是「用量没读到」`}
              tone="text-ink-stall"
              items={[
                ...withProblem.map((p) => (
                  <li key={`problem-${p.id}`} className="min-w-0">
                    <SummaryName pool={p} />
                    <PoolProblemLine
                      problem={problems.get(p.id) as PoolProblem}
                      now={now}
                      className="mt-0.5"
                    />
                  </li>
                )),
                ...unread.map((p) => (
                  <li key={`unread-${p.id}`} className="flex items-start gap-2">
                    <SummaryName pool={p} />
                    <span className="shrink-0 text-ink-stall">没查成</span>
                  </li>
                )),
                ...unknownUse.map((c, i) => (
                  <li key={`unknown-${key(c, i)}`} className="flex items-start gap-2">
                    <SummaryName pool={c.pool} w={c.w} />
                    <span className="shrink-0 text-ink-stall">{quotaValue(c.w)}</span>
                  </li>
                )),
                ...unreported.map((c, i) => (
                  <li key={`unreported-${key(c, i)}`} className="flex items-start gap-2">
                    <SummaryName pool={c.pool} w={c.w} />
                    <span className="shrink-0 text-ink-stall">上游这次没报</span>
                  </li>
                )),
                ...stale.map((c, i) => (
                  <li key={key(c, i)} className="flex items-start gap-2">
                    <SummaryName pool={c.pool} w={c.w} />
                    <span className="num shrink-0 text-ink-stall">
                      {formatAgo(c.w.readAt, now)}
                      {readingVerb(c.w.reading)}
                    </span>
                  </li>
                )),
              ]}
            />
          </div>

          <p className="mt-5 mb-2 text-xs text-muted-foreground">
            实读 = 从官方接口或它自家网页的用量接口读到；估算 =
            读不到，按我们自己的用量算，撞到限额时记下上限。
          </p>
          {pools.length === 0 ? (
            <Panel>
              <Empty icon={Gauge} title="还没有账号池" />
            </Panel>
          ) : (
            <Matrix pools={pools} kinds={kinds} now={now} problems={problems} />
          )}
          {poolProblems.error ? (
            <p data-pool-problems="unreadable" className="mt-2 text-caption text-ink-stall">
              账号池的毛病（额度读不到、凭据过期）没读成：{errorText(poolProblems.error)}
              。表里没写不代表没有。
            </p>
          ) : null}
        </>
      )}
    </Page>
  );
}

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
  return (
    <div className="quota-matrix">
      {/* 表比这一列窄时才露出来：写在表上方，第一屏就能看见；够宽时由样式藏起。 */}
      <p className="quota-scroll-hint mb-1.5 text-right text-caption font-medium text-muted-foreground">
        向右滑动，看其余窗口
      </p>
      <div className="relative">
        <div className="overflow-x-auto rounded-xl border bg-card scrollbar-thin">
          <table className="w-full min-w-quota-table table-fixed border-collapse text-left">
            <caption className="sr-only">每个账号池、每个时间窗的额度</caption>
            <colgroup>
              <col className="w-quota-row" />
              {kinds.map((k) => (
                <col key={k} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-normal">
                  账号池
                </th>
                {kinds.map((k) => (
                  <th scope="col" key={k} className="px-2 py-2 font-normal">
                    {windowLabel[k]}
                  </th>
                ))}
              </tr>
            </thead>
            {channels.map((ch) => {
              const list = pools.filter((p) => p.channelId === ch.channelId);
              return (
                <tbody key={ch.channelId}>
                  <tr className="border-b bg-background/40">
                    <th scope="colgroup" colSpan={kinds.length + 1} className="px-4 py-1.5 text-xs">
                      <span className="flex items-center gap-2">
                        <span className="font-semibold">{ch.channelName}</span>
                        <Badge variant="outline" className="h-4 px-1 text-micro font-normal">
                          {ch.billing ? billingLabel[ch.billing] : '计费未知'}
                        </Badge>
                        {ch.channelEnabled ? null : <span className="text-muted-foreground">已下架</span>}
                      </span>
                    </th>
                  </tr>
                  {list.map((p) => (
                    <tr key={p.id} className="border-b align-top last:border-b-0">
                      <th scope="row" className="px-4 py-3 font-normal">
                        <div className="num text-sm font-medium">{p.id}</div>
                        <div className="mt-0.5 text-caption text-muted-foreground">
                          {p.expiresAt ? (
                            <>
                              <span className="num">{formatDate(p.expiresAt)}</span> 到期 ·{' '}
                              <span className="num">{formatInDays(p.expiresAt, now)}</span>
                            </>
                          ) : (
                            '没有到期日'
                          )}
                        </div>
                        <div className="mt-0.5 text-caption text-muted-foreground">
                          {
                            routeSlots({
                              inFlight: p.running,
                              reserved: p.reserved,
                              maxConcurrency: p.maxConcurrency,
                            }).text
                          }
                        </div>
                        {problems.has(p.id) ? (
                          <PoolProblemLine
                            problem={problems.get(p.id) as PoolProblem}
                            className="mt-1 font-normal"
                          />
                        ) : null}
                      </th>
                      {kinds.map((k) => {
                        const ws = p.windows.filter((x) => x.window === k);
                        // 同一池同一类窗有新旧两张时：过期的收成一行灰字，不与新读数并排占大格
                        const expired = ws.filter((w) => isExpiredWindow(w, now));
                        const current = ws.filter((w) => !isExpiredWindow(w, now));
                        const collapseExpired = expired.length > 0 && current.length > 0;
                        const showFull = collapseExpired ? current : ws;
                        return (
                          <td key={k} className="p-2">
                            {ws.length ? (
                              <div className="space-y-2">
                                {showFull.map((w, i) => (
                                  // biome-ignore lint/suspicious/noArrayIndexKey: 同一种窗可能有好几个（按模型组），契约里没有区分它们的字段。
                                  <QuotaCell key={i} w={w} now={now} />
                                ))}
                                {collapseExpired
                                  ? expired.map((_, i) => (
                                      // biome-ignore lint/suspicious/noArrayIndexKey: 同上，过期旧读数没有稳定主键。
                                      <ExpiredQuotaLine key={`expired-${i}`} />
                                    ))
                                  : null}
                              </div>
                            ) : (
                              <div
                                className={cn(
                                  'grid h-full min-h-10 place-items-center text-xs',
                                  p.quotaStatus === 'unread' ? 'text-ink-stall' : 'text-faint',
                                )}
                              >
                                {p.quotaStatus === 'unread' ? '没查成' : '—'}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
        <div
          className="quota-scroll-hint quota-scroll-fade pointer-events-none absolute inset-y-px right-px w-12 rounded-r-xl"
          aria-hidden
        />
      </div>
    </div>
  );
}
