import { type QuotaPace, quotaPace } from '@fleet-dao/shared';
import type { QuotaWindowView } from '../api/types';
import {
  formatUtil,
  isNearlyExhausted,
  isUpstreamFull,
  isUseItOrLoseIt,
  upstreamStatusLabel,
  utilOf,
  windowRawNote,
  windowTitle,
} from '../lib/catalog';
import { formatAgo, formatCount, formatIn, formatPercent, formatUsd } from '../lib/format';
import { cn } from '../lib/utils';
import { StatusBadge } from './layout/status-badge';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

/** 额度条的颜色：够用是中性色，75% 以上黄，90% 以上红。 */
export function quotaTone(util: number): string {
  if (util >= 0.9) return 'bg-st-fail';
  if (util >= 0.75) return 'bg-st-stall';
  return 'bg-muted-foreground';
}

/** 额度条。用量没读到（undefined）时只画虚线空槽，不画成 0%。 */
export function QuotaBar({ util, className }: { util: number | undefined; className?: string }) {
  if (util === undefined) {
    return (
      <div
        className={cn('h-1.5 w-full rounded-full border border-dashed border-border-strong', className)}
        title="用量没读到"
        data-unknown="true"
      />
    );
  }
  const pct = Math.max(0, Math.min(1, util));
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-selected', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-300', quotaTone(pct))}
        style={{ width: `${Math.max(2, pct * 100)}%` }}
      />
    </div>
  );
}

/** 实读是上游读到的，时间写「读」；估算没有上游读取，按本机用量算，时间写「算」。 */
export function readingVerb(reading: QuotaWindowView['reading']): '读' | '算' {
  return reading === 'measured' ? '读' : '算';
}

/** 每个额度数字都要标明来源：实读（接口读到的）还是估算（按我们自己的用量算的），悬停看读法（reclaude-carpool……）。 */
export function ReadingBadge({ w, className }: { w: QuotaWindowView; className?: string }) {
  const measured = w.reading === 'measured';
  // 读数过期（#1748）：旧数不能挂「实读」的牌子，换成「读数过期」，颜色和「读数过期」那一栏对上
  if (w.stale) {
    return (
      <span
        title={`${measured ? '从官方或网页接口读到的' : '按我们自己的用量估的'}，但读数太旧，不是现值（读法 ${w.source}）`}
        data-source={w.source}
        data-stale-badge="true"
        className={cn('inline-flex shrink-0', className)}
      >
        <StatusBadge tone="stall" label="读数过期" />
      </span>
    );
  }
  // 实读是安静的绿点，估算是「存疑」色的点：两种都只有点和字，不抢数字的位置
  return (
    <span
      title={`${measured ? '从官方或网页接口读到的' : '读不到，按我们自己的用量估的'}（读法 ${w.source}）`}
      data-source={w.source}
      className={cn('inline-flex shrink-0', className)}
    >
      <StatusBadge tone={measured ? 'done' : 'doubt'} label={measured ? '实读' : '估算'} variant="dot" />
    </span>
  );
}

/** 按单位写数：美元、百分比、token、点数。 */
export function amount(w: Pick<QuotaWindowView, 'unit'>, n: number): string {
  switch (w.unit) {
    case 'usd':
      return formatUsd(n);
    case 'percent':
      return `${Math.round(n)}%`;
    case 'tokens':
      return formatCount(n);
    case 'points':
      return formatCount(n);
  }
}

/**
 * 同一行的已用 / 上限：token、点数用同一个单位、同一位小数（都用「万」或都用整数），
 * 避免各自 formatCount 混成「8,623.515 / 50.0 万」。
 */
export function amountPair(w: Pick<QuotaWindowView, 'unit'>, used: number, limit: number): string {
  if (w.unit === 'usd') return `${formatUsd(used)} / ${formatUsd(limit)}`;
  if (w.unit === 'percent') return `${Math.round(used)}% / ${Math.round(limit)}%`;
  const scale = Math.max(Math.abs(used), Math.abs(limit));
  if (scale < 10_000) {
    return `${formatCount(used)} / ${formatCount(limit)}`;
  }
  if (scale < 100_000_000) {
    return `${(used / 10_000).toFixed(1)} 万 / ${(limit / 10_000).toFixed(1)} 万`;
  }
  return `${(used / 100_000_000).toFixed(1)} 亿 / ${(limit / 100_000_000).toFixed(1)} 亿`;
}

/** 一句话的用量：「已用满」「$3.20 / $10.00」「40%」「已用 812，上限没读到」「用量没读到」。 */
export function quotaValue(w: QuotaWindowView): string {
  const util = utilOf(w);
  // 上游说已用满以它为准，排在数字前面说；有比例就顺带写上。
  if (isUpstreamFull(w)) return util === undefined ? '已用满' : `已用满 · ${formatPercent(util)}`;
  if (w.used !== undefined && w.limit !== undefined) return amountPair(w, w.used, w.limit);
  if (util !== undefined) return formatPercent(util);
  if (w.used !== undefined) return `已用 ${amount(w, w.used)}，上限没读到`;
  return '用量没读到';
}

/** 清零时刻已过，或上游这次没再报：算过期的旧读数。 */
export function isExpiredWindow(w: Pick<QuotaWindowView, 'staleSince' | 'resetsAt'>, now: number): boolean {
  if (w.staleSince) return true;
  if (w.resetsAt && Date.parse(w.resetsAt) <= now) return true;
  return false;
}

/** 同一格里新旧两张卡时，过期那张收成一行灰字，不占大格。 */
export function ExpiredQuotaLine() {
  return (
    <div
      className="rounded-md border border-dashed bg-muted px-2.5 py-1.5 text-meta text-muted-foreground"
      data-expired="true"
    >
      旧读数，已过期
    </div>
  );
}

/** 一个时间窗的一格：用量、条、清零倒计时、来源和读数新鲜度（stale 由后端按 30 分钟判）。 */
export function QuotaCell({ w, now }: { w: QuotaWindowView; now: number }) {
  const util = utilOf(w);
  // 过期的读数不能当现值：不据此喊「先用它」。用量没读到的也不喊。
  const hot = !w.stale && isUseItOrLoseIt(w, now);
  const full = isNearlyExhausted(w);
  // 上游说满了、却没给比例（Claude 撞限额时就这样）：照「已用满」写，条画满，不算「用量没读到」。
  const upstreamFull = isUpstreamFull(w);
  const known = util !== undefined || upstreamFull;
  const pair =
    w.used !== undefined && w.limit !== undefined ? amountPair(w, w.used, w.limit).split(' / ') : null;
  return (
    <div
      className={cn(
        'rounded-md border p-2.5 transition-colors',
        hot && 'border-brand bg-accent shadow-brand-ring',
      )}
      data-hot={hot || undefined}
      data-full={full || undefined}
      data-stale={w.stale || undefined}
      data-unknown={!known || undefined}
    >
      {/* 表头已经写了是哪种窗：格子里只在多出信息（按模型组、上游自报的窗名）时才再写一遍，省下一行（驾驶舱改版 2026-10-07）。模型名放不下就换行，不单行截成「o...」。 */}
      {w.scope || w.window === 'other' ? (
        <div className="mb-1 min-w-0 break-words text-meta text-muted-foreground" title={windowRawNote(w)}>
          {windowTitle(w)}
        </div>
      ) : null}
      {/* 金额放得下就跟百分比、来源同一行；放不下就换行，不单行截成「$61.…」。 */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        {pair ? (
          <span className="num whitespace-normal">
            <span
              className={cn(
                'text-body font-semibold',
                full && 'text-ink-fail',
                w.stale && 'text-muted-foreground',
              )}
            >
              {pair[0]}
            </span>
            <span className="text-meta text-muted-foreground"> / {pair[1]}</span>
          </span>
        ) : util !== undefined ? (
          <span
            className={cn(
              'num text-body font-semibold',
              full && 'text-ink-fail',
              w.stale && 'text-muted-foreground',
            )}
          >
            {formatPercent(util)}
          </span>
        ) : upstreamFull ? (
          <span className="text-body font-semibold text-ink-fail">已用满</span>
        ) : w.used !== undefined ? (
          <span className="num whitespace-normal">
            <span className="text-body font-semibold">{amount(w, w.used)}</span>
            <span className="text-meta text-muted-foreground"> 已用，上限没读到</span>
          </span>
        ) : (
          <span className="text-body font-medium text-ink-stall">用量没读到</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {w.used !== undefined && util !== undefined ? (
            <span className="num text-meta text-muted-foreground">{formatUtil(util)}</span>
          ) : null}
          <ReadingBadge w={w} />
        </span>
      </div>
      <QuotaBar
        util={util ?? (upstreamFull ? 1 : undefined)}
        className={cn('mt-1.5', w.stale && 'opacity-40')}
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 text-meta text-muted-foreground">
        {w.resetsAt ? (
          <span className={cn(hot && 'font-medium text-foreground')}>
            <span className="num">{formatIn(w.resetsAt, now)}</span>清零
          </span>
        ) : (
          <span>清零时间没读到</span>
        )}
        <span
          data-tone={w.stale ? 'stall' : undefined}
          className={cn(w.stale && 'text-ink-stall')}
          title={w.stale ? '读数太旧，不能当现值用' : undefined}
        >
          {w.reading === 'measured' ? null : <span>按本机用量估算 · </span>}
          <span className="num">{formatAgo(w.readAt, now)}</span>
          {readingVerb(w.reading)}
        </span>
      </div>
      {hot && util !== undefined ? (
        <div className="mt-1.5 text-meta font-medium text-foreground">
          快清零还剩 <span className="num">{formatPercent(1 - util)}</span>，先用它
        </div>
      ) : null}
      {full ? <div className="mt-1.5 text-meta font-medium text-ink-fail">快用完了，调度会先绕开</div> : null}
      {w.upstreamStatus && w.upstreamStatus !== 'allowed' ? (
        <div
          className={cn(
            'mt-1.5 text-meta font-medium',
            w.upstreamStatus === 'limit_reached' ? 'text-ink-fail' : 'text-ink-stall',
          )}
          title={w.statusRaw ? `上游原话：${w.statusRaw}` : undefined}
        >
          {upstreamStatusLabel[w.upstreamStatus]}
        </div>
      ) : null}
      {w.stale ? (
        <div data-stale-note className="mt-1.5 text-meta font-medium text-ink-stall">
          读数过期，上面是 <span className="num">{formatAgo(w.readAt, now)}</span>
          {readingVerb(w.reading)}到的旧数，不是现值，不参与排序
        </div>
      ) : null}
      {w.staleSince ? (
        <div className="mt-1.5 text-meta text-ink-stall">
          上游从 <span className="num">{formatAgo(w.staleSince, now)}</span>
          起没再报这个窗，数是之前的，不参与排序
        </div>
      ) : !known ? (
        <div className="mt-1.5 text-meta text-muted-foreground">不参与「先用它」和排序</div>
      ) : null}
    </div>
  );
}

/**
 * 这个窗口的消耗进度（#2363，和选路同一份算法 shared 的 quotaPace）：读数过期、上游没报、用量或清零时刻没读到时算不出，返回 undefined。
 */
export function paceOf(w: QuotaWindowView, now: number): QuotaPace | undefined {
  if (w.stale || w.staleSince) return undefined;
  return (
    quotaPace({ window: w.window, label: w.label, used: utilOf(w), resetsAt: w.resetsAt }, now) ?? undefined
  );
}

/** 「按时间该用 62%，实际 75%」；窗口长度推不出、按 30 天估的补「（按 30 天估）」。 */
export function paceText(p: QuotaPace): string {
  return `按时间该用 ${formatPercent(p.elapsed)}，实际 ${formatPercent(p.used)}${p.estimated ? '（按 30 天估）' : ''}`;
}

/**
 * 额度页账号池里一个窗口的一格（#1805）：一行字（已用 / 上限 · 几时清零 · 来源）加一根细进度条，数字等宽。
 * 比 QuotaCell 少的说明（先用它、快用完、读数过期、上游状态……）收进悬停提示，颜色和小标记照样在：
 * 先用它铺淡底、清零时刻加粗，快用完红字，读数过期换「读数过期」牌。窗口名只在窄屏（表头藏起来的时候）或有额外信息（模型组、上游自报名）时写。
 */
export function QuotaLine({ w, now }: { w: QuotaWindowView; now: number }) {
  const util = utilOf(w);
  const hot = !w.stale && isUseItOrLoseIt(w, now);
  const full = isNearlyExhausted(w);
  const upstreamFull = isUpstreamFull(w);
  const known = util !== undefined || upstreamFull;
  const pair =
    w.used !== undefined && w.limit !== undefined ? amountPair(w, w.used, w.limit).split(' / ') : null;
  const extraLabel = Boolean(w.scope) || w.window === 'other';
  const pace = paceOf(w, now);
  const notes = [
    hot && util !== undefined ? `快清零还剩 ${formatPercent(1 - util)}，先用它` : null,
    full ? '快用完了，调度会先绕开' : null,
    w.upstreamStatus && w.upstreamStatus !== 'allowed' ? upstreamStatusLabel[w.upstreamStatus] : null,
    w.stale
      ? `读数过期，是 ${formatAgo(w.readAt, now)}${readingVerb(w.reading)}到的旧数，不是现值，不参与排序`
      : null,
    w.staleSince ? `上游从 ${formatAgo(w.staleSince, now)}起没再报这个窗，数是之前的，不参与排序` : null,
    !known && !w.staleSince ? '不参与「先用它」和排序' : null,
    w.reading === 'measured' ? null : '按本机用量估算',
    `${formatAgo(w.readAt, now)}${readingVerb(w.reading)}`,
  ].filter(Boolean);
  const strong = cn('font-semibold', full && 'text-ink-fail', w.stale && 'text-muted-foreground');
  // 点一下弹出这一格的说明（#1820）：原来只挂在悬停提示（title）上，手机没有悬停所以看不到。电脑上悬停提示照旧。
  const popNotes = [
    ...notes,
    pace && w.window !== '5h'
      ? `${paceText(pace)}：同一模型的几个渠道里，用得比时间慢 10% 以上的调度先用，快 10% 以上的往后放`
      : null,
    `读法：${w.source}（${w.reading === 'measured' ? '从官方或网页接口读到的' : '读不到，按我们自己的用量估的'}）`,
    windowRawNote(w),
    w.statusRaw && w.upstreamStatus && w.upstreamStatus !== 'allowed' ? `上游原话：${w.statusRaw}` : null,
  ].filter((n): n is string => Boolean(n));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-quota-line
          data-hot={hot || undefined}
          data-full={full || undefined}
          data-stale={w.stale || undefined}
          data-unknown={!known || undefined}
          title={notes.join('；')}
          className={cn(
            'block w-full min-w-0 cursor-pointer rounded-md border border-transparent px-2 py-1 text-left focus-visible:ring-focus focus-visible:ring-ring focus-visible:outline-none',
            // 先用它只铺一层悬停色的底、清零时刻加粗，不再描粗框（样板：层级靠字重和灰度，不靠边框，#1921）
            hot && 'bg-accent',
          )}
        >
          <div
            className={cn(
              'min-w-0 break-words text-meta text-muted-foreground',
              !extraLabel && 'quota-cell-label',
            )}
            title={windowRawNote(w)}
          >
            {windowTitle(w)}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2 text-meta">
            {pair ? (
              <span className="num whitespace-normal">
                <span className={strong}>{pair[0]}</span>
                <span className="text-muted-foreground"> / {pair[1]}</span>
              </span>
            ) : util !== undefined ? (
              <span className={cn('num', strong)}>{formatPercent(util)}</span>
            ) : upstreamFull ? (
              <span className="font-semibold text-ink-fail">已用满</span>
            ) : w.used !== undefined ? (
              <span className="num whitespace-normal">
                <span className="font-semibold">{amount(w, w.used)}</span>
                <span className="text-muted-foreground"> 已用，上限没读到</span>
              </span>
            ) : (
              <span className="font-medium text-ink-stall">用量没读到</span>
            )}
            {/* 美元、token 窗：金额之外把已用百分比也写出来（重排前就有），和进度条对得上。 */}
            {pair && util !== undefined && w.unit !== 'percent' ? (
              <span className={cn('num', w.stale ? 'text-muted-foreground' : full && 'text-ink-fail')}>
                {formatUtil(util)}
              </span>
            ) : null}
            <span
              className={cn(
                'text-meta whitespace-nowrap text-muted-foreground',
                hot && 'font-medium text-foreground',
              )}
            >
              {w.resetsAt ? (
                <>
                  <span className="num">{formatIn(w.resetsAt, now)}</span>清零
                </>
              ) : (
                '清零时间没读到'
              )}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <QuotaBar
              util={util ?? (upstreamFull ? 1 : undefined)}
              className={cn('min-w-12 flex-1', w.stale && 'opacity-40')}
            />
            <ReadingBadge w={w} />
            {/* 读数过期时小牌换成「读数过期」，估算这层来源就看不见了：估算的补一句，实读 / 估算不丢。 */}
            {w.stale && w.reading !== 'measured' ? (
              <span className="shrink-0 text-meta text-muted-foreground">按本机用量估算</span>
            ) : null}
          </div>
          {/* 消耗进度一行（#2363）：和选路同一份算法；超出时间进度 10% 以上的标黄（选路往后放；5 小时窗不参与排序，不标）。 */}
          {pace ? (
            <div
              data-quota-pace
              className={cn(
                'num mt-0.5 min-w-0 break-words text-meta text-muted-foreground',
                w.window !== '5h' && pace.behind <= -0.1 && 'text-ink-stall',
              )}
            >
              {paceText(pace)}
            </div>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-xs space-y-1.5 text-body" data-quota-notes>
        {popNotes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </PopoverContent>
    </Popover>
  );
}
