import type { LucideIcon } from 'lucide-react';
import { Flame, Gauge, TimerOff, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { brand } from '#brand';
import { usePools } from '../api/client';
import type { PoolView, QuotaWindowKind, QuotaWindowView } from '../api/types';
import { NotBuilt } from '../components/not-built';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { QuotaCell, quotaValue } from '../components/quota';
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
        <ul className="mt-3 space-y-1.5 text-[13px]">{items}</ul>
      ) : (
        <p className="mt-3 text-[13px] text-muted-foreground">没有</p>
      )}
    </div>
  );
}

type Cell = { pool: PoolView; w: QuotaWindowView };

export default function Quota() {
  const { data, error, isLoading } = usePools();
  const now = useNow();

  if (error) {
    return (
      <Page title="额度">
        <LoadError error={error} />
      </Page>
    );
  }

  const pools = data?.pools ?? [];
  const cells: Cell[] = pools.flatMap((pool) => pool.windows.map((w) => ({ pool, w })));
  const label = ({ pool, w }: Cell) => `${poolTitle(pool)} · ${windowTitle(w)}`;
  const key = ({ pool, w }: Cell, i: number) => `${pool.id}-${w.window}-${i}`;
  const hot = cells.flatMap((c) => {
    const util = utilOf(c.w);
    return !c.w.stale && util !== undefined && isUseItOrLoseIt(c.w, now) ? [{ ...c, util }] : [];
  });
  const full = cells.filter(({ w }) => isNearlyExhausted(w));
  const stale = cells.filter(({ w }) => w.stale);
  // 读成了但没有用量比例（只报了清零时间，或只有已用没有上限）：不参与「先用它」和排序，但要列出来。
  const unknownUse = cells.filter(
    ({ w }) => !w.stale && !w.staleSince && !isUpstreamFull(w) && utilOf(w) === undefined,
  );
  // 读成过、但上游这次没再报：数是之前的，照样列出来。
  const unreported = cells.filter(({ w }) => !w.stale && w.staleSince);
  const unread = pools.filter((p) => p.quotaStatus === 'unread');
  const kinds = [...new Set(cells.map(({ w }) => w.window))].sort((a, b) => windowRank[a] - windowRank[b]);
  const staleMinutes = data?.staleAfterMinutes ?? 30;

  return (
    <Page
      title="额度"
      description="每个账号池、每个时间窗：用了多少、几点清零，每个数都写明是实读还是估算。快清零还剩不少的会高亮——调度会先用它。"
    >
      {isLoading || !data ? (
        <LoadingRows rows={6} />
      ) : data.quotaNotWired ? (
        // 额度读取还没做：整块换成待实现占位，不在格子里写「没查成」
        <NotBuilt notWired={data.quotaNotWired} />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Callout
              icon={Flame}
              title="先用它"
              hint="快清零了还剩不少，不用就浪费"
              tone="text-foreground"
              items={hot.map((c, i) => (
                <li key={key(c, i)} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{label(c)}</span>
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
                <li key={key(c, i)} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{label(c)}</span>
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
                ...unread.map((p) => (
                  <li key={`unread-${p.id}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{poolTitle(p)}</span>
                    <span className="shrink-0 text-ink-stall">没查成</span>
                  </li>
                )),
                ...unknownUse.map((c, i) => (
                  <li key={`unknown-${key(c, i)}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{label(c)}</span>
                    <span className="shrink-0 text-ink-stall">{quotaValue(c.w)}</span>
                  </li>
                )),
                ...unreported.map((c, i) => (
                  <li key={`unreported-${key(c, i)}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{label(c)}</span>
                    <span className="shrink-0 text-ink-stall">上游这次没报</span>
                  </li>
                )),
                ...stale.map((c, i) => (
                  <li key={key(c, i)} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{label(c)}</span>
                    <span className="num shrink-0 text-ink-stall">{formatAgo(c.w.readAt, now)}读</span>
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
            <Matrix pools={pools} kinds={kinds} now={now} />
          )}
        </>
      )}
    </Page>
  );
}

function Matrix({ pools, kinds, now }: { pools: PoolView[]; kinds: QuotaWindowKind[]; now: number }) {
  const channels = [...new Map(pools.map((p) => [p.channelId, p])).values()];
  return (
    <div className="overflow-x-auto rounded-xl border bg-card scrollbar-thin">
      <table className="w-full min-w-[860px] table-fixed border-collapse text-left">
        <caption className="sr-only">每个账号池、每个时间窗的额度</caption>
        <colgroup>
          <col className="w-[220px]" />
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
                    <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
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
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {p.expiresAt ? (
                        <>
                          <span className="num">{formatDate(p.expiresAt)}</span> 到期 ·{' '}
                          <span className="num">{formatInDays(p.expiresAt, now)}</span>
                        </>
                      ) : (
                        '没有到期日'
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      在跑 <span className="num">{p.running}</span>/
                      <span className="num">{p.maxConcurrency}</span>
                    </div>
                  </th>
                  {kinds.map((k) => {
                    const ws = p.windows.filter((x) => x.window === k);
                    return (
                      <td key={k} className="p-2">
                        {ws.length ? (
                          <div className="space-y-2">
                            {ws.map((w, i) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: 同一种窗可能有好几个（按模型组），契约里没有区分它们的字段。
                              <QuotaCell key={i} w={w} now={now} />
                            ))}
                          </div>
                        ) : (
                          <div
                            className={cn(
                              'grid h-full min-h-20 place-items-center text-xs',
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
  );
}
