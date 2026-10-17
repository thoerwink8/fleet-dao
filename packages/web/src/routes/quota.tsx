// 额度页（照路由页样板 #1914 重做，#1921）：页头一句说明，长说明和读法在 ⓘ；顶上三行结论块（现在先用哪个池、
// 快用完几个、几个读数过期）；下面三个摘要标签点开看明细；再下面是池 × 窗口的表。
// 改这里之前必须知道：
// - 一行一个主信息一个状态：池名一行，在跑几个和到期日并成一行灰字；池的毛病收成一行（放不下截断），整句在悬停里，
//   「读数过期或没查成」那块摘要里照旧是整句（手机上没有悬停，从那里看）。
// - 读过一次、刷新失败：照旧画上一次的数，顶上一条带重试的横幅，不把看得到的清空；一次都没读成才整页只写没查成。
// - 结论块的三行在任何宽度都不折（nowrap + 截断，整句在 title）。标签字不和摘要标签同名（测试按字找摘要标签）。
import { errMessage } from '@fleet-dao/shared/util';
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
import { StatusBadge } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import type { LayoutTone } from '../components/layout/tone';
import { PoolProblemLine, usePoolProblems } from '../components/pool-problem';
import {
  ChannelHoldControls,
  ChannelHoldForm,
  PoolHoldBanner,
  PoolSwitch,
  PoolSwitchForm,
  PoolSwitchProvider,
} from '../components/pool-switch';
import { ExpiredQuotaLine, isExpiredWindow, QuotaLine, quotaValue, readingVerb } from '../components/quota';
import { QuotaNotice } from '../components/quota-notice';
import { QuotaPressure } from '../components/quota-pressure';
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

const SUMMARY = '每个账号池、每个时间窗用了多少、几点清零。';
const DESCRIPTION = (
  <div className="space-y-2">
    <p>每个数都写明是实读还是估算。快清零还剩不少的会高亮：调度会先用它；用了九成以上的，调度会先绕开。</p>
    <p>
      每格最后一行「按时间该用 X%，实际
      Y%」：同一模型的几个渠道里，用得比时间慢一成以上的调度先用，快一成以上的往后放（标黄）。
    </p>
    <p>
      实读：从官方接口或它自家网页的用量接口读到的。估算：读不到，按我们自己的用量算，撞到限额时记下上限。
    </p>
    <p>
      读数过期：超过一段时间没读到新数，旧数不当现值用、不参与排序。没查成：一条都没读到，不是「没用量」。用量没读到：只读到了清零时间。
    </p>
    <p>点表里任何一格，弹出这一格的说明（读法、上游原话、读数新不新）。</p>
    <p>
      每个池那一行的开关是停用：关掉只写一句原因，复查日期可不填。引擎探到封号或登录失效时，这一行写「封号」，开关不跟着动。
    </p>
    <p>
      每个渠道的标题行右边有「全部暂停」「全部放开」：一次动这个渠道下所有池，同样要写原因。一部分池已停时变成「暂停其余」「放开已停」，各只动自己那一半；认不出的暂停和封号提醒不会被放开。
    </p>
  </div>
);

/** 摘要面板：点上面的标签展开，一次只开一块。第一行是这一栏的说明，下面一行一项。 */
function SummaryPanel({
  title,
  hint,
  short,
  items,
}: {
  title: string;
  hint: string;
  /** 手机上放不下一行时的短说法；整句在悬停和页头 ⓘ 里。 */
  short?: string | undefined;
  items: ReactNode[];
}) {
  return (
    <Section flush data-quota-panel aria-label={title} className="mt-3">
      {/* 卡头说明一行不折（样板 #1914）：桌面放不下截断，手机换短说法 */}
      <p
        title={hint}
        className="truncate whitespace-nowrap border-b px-4 py-2 text-meta text-muted-foreground"
      >
        {short ? (
          <>
            <span className="max-md:hidden">{hint}</span>
            <span className="md:hidden">{short}</span>
          </>
        ) : (
          hint
        )}
      </p>
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

/**
 * 顶上的结论块：这一页最该看的一句——现在先用哪个池的哪个窗；没有要抢着用的，就说哪个快用完；都没有就说够用。
 * 三行：池名（text-subtitle）、一句结论加状态、灰字补充（还有几个快用完、几个读数过期、几个要人处理）。每行都不折。
 */
function QuotaHero({
  pools,
  hot,
  full,
  stuck,
  staleCount,
  windows,
  now,
}: {
  pools: PoolView[];
  hot: (Cell & { util: number })[];
  full: Cell[];
  /** 读不到、凭据过期、一次没读成的池：要人处理。 */
  stuck: number;
  /** 「读数过期或没查成」那块的条数。 */
  staleCount: number;
  windows: number;
  now: number;
}) {
  const soonest = [...hot].sort((a, b) => Date.parse(a.w.resetsAt ?? '') - Date.parse(b.w.resetsAt ?? ''))[0];
  const firstFull = full[0];
  let name: string;
  let line: string;
  let badge: ReactNode;
  if (soonest) {
    name = poolTitle(soonest.pool);
    line = `${windowTitle(soonest.w)}还剩 ${formatPercent(1 - soonest.util)}，${
      soonest.w.resetsAt ? `${formatIn(soonest.w.resetsAt, now)}清零` : '清零时间没读到'
    }`;
    badge = <StatusBadge tone="done" label="该先用" />;
  } else if (firstFull) {
    name = poolTitle(firstFull.pool);
    line = `${windowTitle(firstFull.w)}：${quotaValue(firstFull.w)}，调度会先绕开`;
    badge = <StatusBadge tone="fail" label="快满了" />;
  } else {
    name = `${pools.length} 个账号池`;
    line = '都够用：没有快清零要抢着用的，也没有快用完的';
    badge = <StatusBadge tone="done" label="够用" />;
  }
  // 结论句已经写了的那一个不再数进灰字
  const otherFull = soonest ? full.length : full.length - 1;
  const notes = [
    hot.length > 1 ? `另有 ${hot.length - 1} 个窗该先用` : null,
    otherFull > 0 ? `${soonest ? '' : '另有 '}${otherFull} 个窗快用完` : null,
    stuck > 0 ? `${stuck} 个池要人处理` : null,
    staleCount > 0 ? `过期或没查成的读数 ${staleCount} 条` : null,
  ].filter((x): x is string => x !== null);
  if (notes.length === 0) notes.push(`${pools.length} 个账号池、${windows} 个时间窗，读数都是新的`);
  const noteText = notes.join(' · ');
  return (
    // 三行、每行都不折（照路由页用途标题块，#1914）：放不下截断，整句在悬停里；状态标签不让位
    <header data-quota-hero className="flex min-w-0 flex-col pt-2">
      <h2 className="mb-3 truncate whitespace-nowrap text-subtitle" title={name}>
        {name}
      </h2>
      <p
        data-hero-line
        title={line}
        className="flex min-w-0 items-center gap-2.5 whitespace-nowrap text-heading font-normal"
      >
        <span data-hero-text className="min-w-0 truncate">
          {line}
        </span>
        <span className="shrink-0">{badge}</span>
      </p>
      <p data-hero-notes title={noteText} className="mt-1.5 truncate text-meta text-muted-foreground">
        {noteText}
      </p>
    </header>
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
  const page = { title: '额度', description: SUMMARY, detail: DESCRIPTION, refresh };

  // 一次都没读成：整页只写没查成和原因、带重试。读成过、刷新失败的在下面照旧画上一次的数，顶上一条横幅
  if (error && !data) {
    return (
      <Page {...page}>
        <LoadError text={`额度没查成：${errMessage(error)}`} error={error} onRetry={() => void refetch()} />
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
    short?: string;
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
      short: `超过 ${staleMinutes} 分钟没新数的，不当现值用`,
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
    <Page {...page}>
      {isLoading || !data ? (
        <LoadingRows rows={6} />
      ) : (
        <div className="flex flex-col gap-6">
          {error ? (
            <LoadError
              text={`额度刷新没查成，下面是上一次读到的：${errMessage(error)}`}
              error={error}
              onRetry={() => void refetch()}
            />
          ) : null}
          {pools.length > 0 ? (
            <QuotaHero
              pools={pools}
              hot={hot}
              full={full}
              stuck={withProblem.length + unread.length}
              staleCount={summaries[2]?.items.length ?? 0}
              windows={cells.length}
              now={now}
            />
          ) : null}
          {/* 切号现状、拼车对账：两项都没有就不占地方（QuotaNotice 自己判） */}
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
              <SummaryPanel
                title={openSummary.title}
                hint={openSummary.hint}
                short={openSummary.short}
                items={openSummary.items}
              />
            ) : null}
          </div>

          <div>
            {pools.length === 0 ? (
              <Section>
                <EmptyState icon={Gauge} title="还没有账号池" />
              </Section>
            ) : (
              <>
                <PoolHoldBanner />
                <PoolSwitchProvider>
                  <Matrix pools={pools} kinds={kinds} now={now} problems={problems} />
                </PoolSwitchProvider>
              </>
            )}
            {pools.length > 0 ? (
              <div className="mt-6">
                <QuotaPressure pools={pools} now={now} />
              </div>
            ) : null}
            {poolProblems.error ? (
              <p data-pool-problems="unreadable" className="mt-2 text-meta text-ink-stall">
                账号池的毛病（额度读不到、凭据过期）没读成：{errorText(poolProblems.error)}
                。表里没写不代表没有。
              </p>
            ) : null}
          </div>
        </div>
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

/** 池名下面一行灰字：在跑几个、几号到期还有几天。不折，放不下截断，整句在悬停里。 */
function PoolMeta({ pool: p, now }: { pool: PoolView; now: number }) {
  const slots = routeSlots({
    inFlight: p.running,
    reserved: p.reserved,
    maxConcurrency: p.maxConcurrency,
  }).text;
  const expiry = p.expiresAt
    ? `${formatDate(p.expiresAt)} 到期 · ${formatInDays(p.expiresAt, now)}`
    : '没有到期日';
  return (
    <div
      data-pool-meta
      title={`${slots} · ${expiry}`}
      className="num truncate whitespace-nowrap text-meta text-muted-foreground"
    >
      {slots} · {expiry}
    </div>
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
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate font-semibold">{ch.channelName}</span>
                      <Tag>{ch.billing ? billingLabel[ch.billing] : '计费未知'}</Tag>
                      {ch.channelEnabled ? null : <StatusBadge tone="stop" label="已下架" variant="dot" />}
                      <ChannelHoldControls channelId={ch.channelId} poolIds={list.map((p) => p.id)} />
                    </span>
                  </th>
                </tr>
                <ChannelHoldForm
                  channelId={ch.channelId}
                  channelName={ch.channelName}
                  poolIds={list.map((p) => p.id)}
                />
                {list.map((p) => (
                  <tr
                    key={p.id}
                    className="quota-pool border-b px-4 py-2 last:border-b-0"
                    style={cols}
                    data-pool={p.id}
                  >
                    <th scope="row" className="quota-pool-head min-w-0 font-normal">
                      {/* 一行池名（加没有额度窗时的一个状态），一行灰字（在跑几个、到期），有毛病再一行；每行都不折 */}
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="num min-w-0 truncate text-body font-medium" title={p.id}>
                          {p.id}
                        </span>
                        {p.windows.length === 0 ? (
                          <span
                            data-quota-empty
                            className={cn(
                              'shrink-0 text-meta',
                              p.quotaStatus === 'unread' ? 'text-ink-stall' : 'text-muted-foreground',
                            )}
                          >
                            {p.quotaStatus === 'unread' ? '没查成' : '无额度窗'}
                          </span>
                        ) : null}
                        <PoolSwitch poolId={p.id} />
                      </div>
                      <PoolMeta pool={p} now={now} />
                      {problems.has(p.id) ? (
                        <PoolProblemLine
                          problem={problems.get(p.id) as PoolProblem}
                          oneLine
                          className="mt-0.5 font-normal"
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
                    <PoolSwitchForm poolId={p.id} />
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
