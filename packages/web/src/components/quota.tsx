import type { QuotaWindowView } from '../api/types';
import { isNearlyExhausted, isUseItOrLoseIt, utilOf, windowLabel } from '../lib/catalog';
import { formatAgo, formatIn, formatPercent, formatUsd } from '../lib/format';
import { cn } from '../lib/utils';

/** 额度条的颜色：够用是中性色，75% 以上黄，90% 以上红。 */
export function quotaTone(util: number): string {
  if (util >= 0.9) return 'bg-st-fail';
  if (util >= 0.75) return 'bg-st-stall';
  return 'bg-foreground/55';
}

export function QuotaBar({ util, className }: { util: number; className?: string }) {
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

export function quotaValue(w: QuotaWindowView): string {
  if (w.used !== undefined && w.limit !== undefined) {
    const money = w.window.endsWith('usd');
    return money ? `${formatUsd(w.used)} / ${formatUsd(w.limit)}` : `${w.used} / ${w.limit}`;
  }
  return formatPercent(utilOf(w));
}

/** 一个时间窗的一格：用量、条、清零倒计时、来源和读数新鲜度（stale 由后端按 30 分钟判）。 */
export function QuotaCell({ w, now }: { w: QuotaWindowView; now: number }) {
  const util = utilOf(w);
  // 过期的读数不能当现值：不据此喊「先用它」。
  const hot = !w.stale && isUseItOrLoseIt(w, now);
  const full = isNearlyExhausted(w);
  const money = w.window.endsWith('usd');
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
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{windowLabel[w.window]}</span>
        <ReadingBadge w={w} />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        {w.used !== undefined && w.limit !== undefined ? (
          <span className="num min-w-0 truncate">
            <span className={cn('text-[17px] font-semibold', full && 'text-st-fail')}>
              {money ? formatUsd(w.used) : w.used}
            </span>
            <span className="text-xs text-muted-foreground"> / {money ? formatUsd(w.limit) : w.limit}</span>
          </span>
        ) : (
          <span className={cn('num text-[17px] font-semibold', full && 'text-st-fail')}>
            {formatPercent(util)}
          </span>
        )}
        {w.used !== undefined ? (
          <span className="num shrink-0 text-xs text-muted-foreground">{formatPercent(util)}</span>
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
          className={cn(w.stale && 'text-st-stall')}
          title={w.stale ? '读数太旧，不能当现值用' : undefined}
        >
          <span className="num">{formatAgo(w.readAt, now)}</span>读
        </span>
      </div>
      {hot ? (
        <div className="mt-1.5 text-[11px] font-medium text-foreground">
          快清零还剩 <span className="num">{formatPercent(1 - util)}</span>，先用它
        </div>
      ) : null}
      {full ? (
        <div className="mt-1.5 text-[11px] font-medium text-st-fail">快用完了，调度会先绕开</div>
      ) : null}
    </div>
  );
}
