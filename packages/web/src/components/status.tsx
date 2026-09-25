import { type Tone, toneBg, toneIcon, toneSoft, toneText } from '../lib/status';
import { cn } from '../lib/utils';

/** 状态标签：图标 + 名字，底色是状态色的淡色。 */
export function StatusChip({ tone, label, className }: { tone: Tone; label: string; className?: string }) {
  const Icon = toneIcon[tone];
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium leading-none whitespace-nowrap',
        toneSoft[tone],
        toneText[tone],
        className,
      )}
    >
      {tone === 'run' ? (
        <StatusDot tone="run" className="mx-0.5 size-1.5" />
      ) : (
        <Icon className="size-3" aria-hidden />
      )}
      {label}
    </span>
  );
}

/** 小圆点；在跑的会一圈圈往外扩。 */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        toneBg[tone],
        toneText[tone],
        tone === 'run' && 'fd-dot-live',
        className,
      )}
    />
  );
}

/** 进度条；在跑的上面有一道光扫过。 */
export function ToneBar({
  value,
  tone,
  live,
  className,
}: {
  value: number;
  tone: Tone;
  live?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-700 ease-out',
          toneBg[tone],
          live && 'fd-sweep',
        )}
        style={{ width: `${pct === 0 ? 0 : Math.max(4, pct * 100)}%` }}
      />
    </div>
  );
}
