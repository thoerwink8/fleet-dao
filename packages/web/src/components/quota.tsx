import type { QuotaWindowView } from '../api/types';
import {
  formatUtil,
  isNearlyExhausted,
  isUseItOrLoseIt,
  upstreamStatusLabel,
  utilOf,
  windowTitle,
} from '../lib/catalog';
import { formatAgo, formatCount, formatIn, formatPercent, formatUsd } from '../lib/format';
import { cn } from '../lib/utils';

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

/** 每个额度数字都要标明来源：实读（接口读到的）还是估算（按我们自己的用量算的）。 */
export function ReadingBadge({ w, className }: { w: QuotaWindowView; className?: string }) {
  const measured = w.reading === 'measured';
  return (
    <span
      title={measured ? '从官方或网页接口读到的' : '读不到，按我们自己的用量估的'}
      className={cn(
        'inline-flex h-4 shrink-0 items-center gap-1 rounded px-1 text-[10px] leading-none whitespace-nowrap',
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

/** 一句话的用量：「$3.20 / $10.00」「40%」「已用 812，上限没读到」「用量没读到」。 */
export function quotaValue(w: QuotaWindowView): string {
  if (w.used !== undefined && w.limit !== undefined) return `${amount(w, w.used)} / ${amount(w, w.limit)}`;
  const util = utilOf(w);
  if (util !== undefined) return formatPercent(util);
  if (w.used !== undefined) return `已用 ${amount(w, w.used)}，上限没读到`;
  return '用量没读到';
}

/** 一个时间窗的一格：用量、条、清零倒计时、来源和读数新鲜度（stale 由后端按 30 分钟判）。 */
export function QuotaCell({ w, now }: { w: QuotaWindowView; now: number }) {
  const util = utilOf(w);
  // 过期的读数不能当现值：不据此喊「先用它」。用量没读到的也不喊。
  const hot = !w.stale && isUseItOrLoseIt(w, now);
  const full = isNearlyExhausted(w);
  return (
    <div
      className={cn(
        'rounded-lg border p-2.5 transition-colors',
        hot && 'border-brand bg-brand/[0.06] shadow-[0_0_0_1px_var(--brand)]',
        full && 'border-st-fail/50 bg-st-fail/[0.06]',
      )}
      data-hot={hot || undefined}
      data-full={full || undefined}
      data-stale={w.stale || undefined}
      data-unknown={util === undefined || undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={`上游原名：${w.label}`}>
          {windowTitle(w)}
        </span>
        <ReadingBadge w={w} />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        {w.used !== undefined && w.limit !== undefined ? (
          <span className="num min-w-0 truncate">
            <span className={cn('text-[17px] font-semibold', full && 'text-ink-fail')}>
              {amount(w, w.used)}
            </span>
            <span className="text-xs text-muted-foreground"> / {amount(w, w.limit)}</span>
          </span>
        ) : util !== undefined ? (
          <span className={cn('num text-[17px] font-semibold', full && 'text-ink-fail')}>
            {formatPercent(util)}
          </span>
        ) : w.used !== undefined ? (
          <span className="num min-w-0 truncate">
            <span className="text-[17px] font-semibold">{amount(w, w.used)}</span>
            <span className="text-xs text-muted-foreground"> 已用，上限没读到</span>
          </span>
        ) : (
          <span className="text-[13px] font-medium text-ink-stall">用量没读到</span>
        )}
        {w.used !== undefined && util !== undefined ? (
          <span className="num shrink-0 text-xs text-muted-foreground">{formatUtil(util)}</span>
        ) : null}
      </div>
      <QuotaBar util={util} className="mt-1.5" />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 text-[11px] text-muted-foreground">
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
          <span className="num">{formatAgo(w.readAt, now)}</span>读
        </span>
      </div>
      {hot && util !== undefined ? (
        <div className="mt-1.5 text-[11px] font-medium text-foreground">
          快清零还剩 <span className="num">{formatPercent(1 - util)}</span>，先用它
        </div>
      ) : null}
      {full ? (
        <div className="mt-1.5 text-[11px] font-medium text-ink-fail">快用完了，调度会先绕开</div>
      ) : null}
      {w.upstreamStatus && w.upstreamStatus !== 'allowed' ? (
        <div
          className={cn(
            'mt-1.5 text-[11px] font-medium',
            w.upstreamStatus === 'limit_reached' ? 'text-ink-fail' : 'text-ink-stall',
          )}
          title={w.statusRaw ? `上游原话：${w.statusRaw}` : undefined}
        >
          {upstreamStatusLabel[w.upstreamStatus]}
        </div>
      ) : null}
      {w.staleSince ? (
        <div className="mt-1.5 text-[11px] text-ink-stall">
          上游从 <span className="num">{formatAgo(w.staleSince, now)}</span>
          起没再报这个窗，数是之前的，不参与排序
        </div>
      ) : util === undefined ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">不参与「先用它」和排序</div>
      ) : null}
    </div>
  );
}
