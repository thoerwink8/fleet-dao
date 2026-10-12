// 状态标签：点或图标 + 字，颜色只是辅助，意思靠字和图标传（规范第五节第 6 条）。合并了原来的 StatusChip。
import { cn } from '../../lib/utils';
import { badgeShape, iconOf, inkClass, type LayoutTone, lineClass, softClass, solidClass } from './tone';

/** 小圆点；在跑的会一圈圈往外扩。 */
export function StatusDot({ tone, className }: { tone: LayoutTone; className?: string }) {
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        solidClass[tone],
        inkClass[tone],
        tone === 'run' && 'fd-dot-live',
        className,
      )}
    />
  );
}

export type StatusBadgeVariant = 'soft' | 'outline' | 'dot';

export function StatusBadge({
  tone,
  label,
  variant = 'soft',
  icon = true,
  className,
}: {
  tone: LayoutTone;
  label: string;
  /** soft 淡底（默认）；outline 描边；dot 只有点和字，没有底（挤在一行里时用）。 */
  variant?: StatusBadgeVariant;
  /** 是否画图标（soft、outline）。关掉就只剩字；在跑的用呼吸点。 */
  icon?: boolean;
  className?: string;
}) {
  const Icon = iconOf(tone);
  return (
    <span
      data-tone={tone}
      data-variant={variant}
      className={cn(
        badgeShape,
        'gap-1',
        variant === 'soft' && cn(softClass[tone], inkClass[tone]),
        variant === 'outline' && cn('border', lineClass[tone], inkClass[tone]),
        variant === 'dot' && 'px-0 text-foreground',
        className,
      )}
    >
      {variant === 'dot' ? (
        <StatusDot tone={tone} />
      ) : icon ? (
        tone === 'run' ? (
          <StatusDot tone="run" className="mx-0.5 size-1.5" />
        ) : (
          <Icon className="size-3" aria-hidden />
        )
      ) : null}
      {label}
    </span>
  );
}
