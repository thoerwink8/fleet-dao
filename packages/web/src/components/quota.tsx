import type { QuotaWindowView } from '../api/types';
import {
  formatUtil,
  isNearlyExhausted,
  isUpstreamFull,
  isUseItOrLoseIt,
  upstreamStatusLabel,
  utilOf,
  windowTitle,
} from '../lib/catalog';
import { formatAgo, formatCount, formatIn, formatPercent, formatUsd } from '../lib/format';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

/** 额度条的颜色：够用是中性色，75% 以上黄，90% 以上红。 */
export function quotaTone(util: number): string {
  if (util >= 0.9) return 'bg-st-fail';
  if (util >= 0.75) return 'bg-st-stall';
  return 'bg-foreground/55';
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
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-700', quotaTone(pct))}
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
        className={cn(
          'inline-flex h-4 shrink-0 items-center gap-1 rounded bg-st-stall/14 px-1 text-micro leading-none whitespace-nowrap text-ink-stall',
          className,
        )}
      >
        <span className="size-1.5 rounded-full bg-st-stall" />
        读数过期
      </span>
    );
  }
  return (
    <span
      title={`${measured ? '从官方或网页接口读到的' : '读不到，按我们自己的用量估的'}（读法 ${w.source}）`}
      data-source={w.source}
      className={cn(
        'inline-flex h-4 shrink-0 items-center gap-1 rounded px-1 text-micro leading-none whitespace-nowrap',
        measured
          ? 'bg-muted text-muted-foreground'
          : 'border border-dashed border-border-strong text-muted-foreground',
        className,
      )}
    >
      <span
        className={cn('size-1.5 rounded-full', measured ? 'bg-foreground/60' : 'border border-foreground/60')}
      />
      {measured ? '实读' : '估算'}
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
      className="rounded-lg border border-dashed bg-muted/40 px-2.5 py-1.5 text-caption text-muted-foreground"
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
        'rounded-lg border p-2.5 transition-colors',
        hot && 'border-brand bg-brand/[0.06] shadow-brand-ring',
        full && 'border-st-fail/50 bg-st-fail/[0.06]',
      )}
      data-hot={hot || undefined}
      data-full={full || undefined}
      data-stale={w.stale || undefined}
      data-unknown={!known || undefined}
    >
      {/* 表头已经写了是哪种窗：格子里只在多出信息（按模型组、上游自报的窗名）时才再写一遍，省下一行（驾驶舱改版 2026-10-07）。模型名放不下就换行，不单行截成「o...」。 */}
      {w.scope || w.window === 'other' ? (
        <div
          className="mb-1 min-w-0 break-words text-caption text-muted-foreground"
          title={`上游原名：${w.label}`}
        >
          {windowTitle(w)}
        </div>
      ) : null}
      {/* 金额放得下就跟百分比、来源同一行；放不下就换行，不单行截成「$61.…」。 */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        {pair ? (
          <span className="num whitespace-normal">
            <span
              className={cn(
                'text-stat-num font-semibold',
                full && 'text-ink-fail',
                w.stale && 'text-muted-foreground',
              )}
            >
              {pair[0]}
            </span>
            <span className="text-xs text-muted-foreground"> / {pair[1]}</span>
          </span>
        ) : util !== undefined ? (
          <span
            className={cn(
              'num text-stat-num font-semibold',
              full && 'text-ink-fail',
              w.stale && 'text-muted-foreground',
            )}
          >
            {formatPercent(util)}
          </span>
        ) : upstreamFull ? (
          <span className="text-stat-num font-semibold text-ink-fail">已用满</span>
        ) : w.used !== undefined ? (
          <span className="num whitespace-normal">
            <span className="text-stat-num font-semibold">{amount(w, w.used)}</span>
            <span className="text-xs text-muted-foreground"> 已用，上限没读到</span>
          </span>
        ) : (
          <span className="text-sub font-medium text-ink-stall">用量没读到</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {w.used !== undefined && util !== undefined ? (
            <span className="num text-xs text-muted-foreground">{formatUtil(util)}</span>
          ) : null}
          <ReadingBadge w={w} />
        </span>
      </div>
      <QuotaBar
        util={util ?? (upstreamFull ? 1 : undefined)}
        className={cn('mt-1.5', w.stale && 'opacity-40')}
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 text-caption text-muted-foreground">
        {w.resetsAt ? (
          <span className={cn(hot && 'font-medium text-foreground')}>
            <span className="num">{formatIn(w.resetsAt, now)}</span>清零
          </span>
        ) : (
          <span>清零时间没读到</span>
        )}
        <span
          className={cn(w.stale && 'text-ink-stall')}
          title={w.stale ? '读数太旧，不能当现值用' : undefined}
        >
          {w.reading === 'measured' ? null : <span>按本机用量估算 · </span>}
          <span className="num">{formatAgo(w.readAt, now)}</span>
          {readingVerb(w.reading)}
        </span>
      </div>
      {hot && util !== undefined ? (
        <div className="mt-1.5 text-caption font-medium text-foreground">
          快清零还剩 <span className="num">{formatPercent(1 - util)}</span>，先用它
        </div>
      ) : null}
      {full ? (
        <div className="mt-1.5 text-caption font-medium text-ink-fail">快用完了，调度会先绕开</div>
      ) : null}
      {w.upstreamStatus && w.upstreamStatus !== 'allowed' ? (
        <div
          className={cn(
            'mt-1.5 text-caption font-medium',
            w.upstreamStatus === 'limit_reached' ? 'text-ink-fail' : 'text-ink-stall',
          )}
          title={w.statusRaw ? `上游原话：${w.statusRaw}` : undefined}
        >
          {upstreamStatusLabel[w.upstreamStatus]}
        </div>
      ) : null}
      {w.stale ? (
        <div data-stale-note className="mt-1.5 text-caption font-medium text-ink-stall">
          读数过期，上面是 <span className="num">{formatAgo(w.readAt, now)}</span>
          {readingVerb(w.reading)}到的旧数，不是现值，不参与排序
        </div>
      ) : null}
      {w.staleSince ? (
        <div className="mt-1.5 text-caption text-ink-stall">
          上游从 <span className="num">{formatAgo(w.staleSince, now)}</span>
          起没再报这个窗，数是之前的，不参与排序
        </div>
      ) : !known ? (
        <div className="mt-1.5 text-caption text-muted-foreground">不参与「先用它」和排序</div>
      ) : null}
    </div>
  );
}

/**
 * 额度页账号池里一个窗口的一格（#1805）：一行字（已用 / 上限 · 几时清零 · 来源）加一根细进度条，数字等宽。
 * 比 QuotaCell 少的说明（先用它、快用完、读数过期、上游状态……）收进悬停提示，颜色和小标记照样在：
 * 先用它描品牌色边，快用完红字，读数过期换「读数过期」牌。窗口名只在窄屏（表头藏起来的时候）或有额外信息（模型组、上游自报名）时写。
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
    `读法：${w.source}（${w.reading === 'measured' ? '从官方或网页接口读到的' : '读不到，按我们自己的用量估的'}）`,
    extraLabel ? null : `上游原名：${w.label}`,
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
            'block w-full min-w-0 cursor-pointer rounded-lg border border-transparent px-2 py-1 text-left focus-visible:ring-focus focus-visible:ring-ring/50 focus-visible:outline-none',
            hot && 'border-brand bg-brand/[0.06]',
            full && 'border-st-fail/50 bg-st-fail/[0.06]',
          )}
        >
          <div
            className={cn('truncate text-caption text-muted-foreground', !extraLabel && 'quota-cell-label')}
            title={`上游原名：${w.label}`}
          >
            {windowTitle(w)}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
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
                'text-caption whitespace-nowrap text-muted-foreground',
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
          <div className="mt-1 flex items-center gap-1.5">
            <QuotaBar
              util={util ?? (upstreamFull ? 1 : undefined)}
              className={cn('min-w-0 flex-1', w.stale && 'opacity-40')}
            />
            <ReadingBadge w={w} />
            {/* 读数过期时小牌换成「读数过期」，估算这层来源就看不见了：估算的补一句，实读 / 估算不丢。 */}
            {w.stale && w.reading !== 'measured' ? (
              <span className="shrink-0 text-micro text-muted-foreground">按本机用量估算</span>
            ) : null}
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-xs space-y-1.5 text-sub" data-quota-notes>
        {popNotes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </PopoverContent>
    </Popover>
  );
}
