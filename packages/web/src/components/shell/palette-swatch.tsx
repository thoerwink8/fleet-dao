import { Check } from 'lucide-react';
import { PALETTES, type PaletteId, type ResolvedMode } from '../../lib/theme';
import { cn } from '../../lib/utils';

/**
 * 主题色小样：元素自己挂 data-palette / data-mode，里面的颜色就按那套主题渲染，
 * 所以同一页能并排看到所有主题的真实颜色，而不是手抄的色块。
 */
export function PaletteSwatch({
  id,
  mode,
  active,
  onPick,
  size = 'sm',
}: {
  id: PaletteId;
  mode: ResolvedMode;
  active: boolean;
  onPick(id: PaletteId): void;
  size?: 'sm' | 'lg';
}) {
  const p = PALETTES.find((x) => x.id === id);
  if (!p) return null;
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      aria-pressed={active}
      aria-label={`主题色：${p.name}`}
      className={cn(
        'group relative overflow-hidden rounded-xl border text-left transition-[box-shadow,transform] hover:-translate-y-px',
        active ? 'outline-2 outline-offset-2 outline-foreground' : 'hover:border-border-strong',
      )}
    >
      <div data-palette={id} data-mode={mode} className="bg-background p-2">
        <div className={cn('flex gap-1.5', size === 'lg' ? 'h-20' : 'h-12')}>
          <div className="flex w-3 flex-col gap-1 rounded-md bg-panel p-0.5">
            <span className="h-1 rounded-full bg-brand" />
            <span className="h-1 rounded-full bg-foreground/25" />
            <span className="h-1 rounded-full bg-foreground/25" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-between rounded-md border bg-card p-1.5">
            <div className="space-y-1">
              <span className="block h-1 w-3/5 rounded-full bg-foreground/70" />
              <span className="block h-1 w-2/5 rounded-full bg-foreground/25" />
            </div>
            <div className="flex gap-1">
              <span className="size-1.5 rounded-full bg-st-run" />
              <span className="size-1.5 rounded-full bg-st-done" />
              <span className="size-1.5 rounded-full bg-st-human" />
              <span className="size-1.5 rounded-full bg-st-stall" />
              <span className="size-1.5 rounded-full bg-st-fail" />
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t bg-card px-2 py-1.5">
        <span className="text-xs font-medium">{p.name}</span>
        <span className="num truncate text-[10px] text-muted-foreground">{p.en}</span>
        {active ? <Check className="ml-auto size-3.5 shrink-0" aria-hidden /> : null}
      </div>
      {size === 'lg' ? (
        <p className="border-t bg-card px-2 pb-2 text-[11px] text-muted-foreground">{p.blurb}</p>
      ) : null}
    </button>
  );
}
