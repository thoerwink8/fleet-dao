// 三版都要的小件：深浅切换、演示版入口、「身后是演示数据」的说明。
import { ArrowRight, Moon, Sun } from 'lucide-react';
import { useTheme } from '../components/theme-provider';
import { DEMO_URL } from '../demo/url';
import { cn } from '../lib/utils';

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedMode, toggleMode } = useTheme();
  const dark = resolvedMode === 'dark';
  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-label={dark ? '换浅色' : '换深色'}
      className={cn(
        'grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

/** 演示版是另一个单页（假数据、不用登录），地址由构建配置给（FLEET_DEMO_URL）：整页跳过去，不走站内路由。 */
export function DemoLink({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <a
      href={DEMO_URL}
      className={cn(
        'group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground',
        className,
      )}
    >
      {children ?? '没有账号？看演示版'}
      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
    </a>
  );
}

/** 等一会儿（登录成功后的过场）。减少动效时不等。 */
export function pause(ms: number): Promise<void> {
  const reduced =
    typeof matchMedia === 'function' &&
    (matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.dataset.motion === 'reduced');
  return new Promise((r) => setTimeout(r, reduced ? 0 : ms));
}

/**
 * 这一块换一套主题色（深浅仍跟着用户选的）。挂 data-palette + data-mode 的地方就地重算全部颜色（app.css）。
 * 注意：弹层（Dialog、Popover）挂在 body 上，出了这一块，要换色的弹层别用传送门。
 */
export function PaletteScope({
  palette,
  className,
  children,
}: {
  palette: import('../lib/theme').PaletteId;
  className?: string;
  children: React.ReactNode;
}) {
  const { resolvedMode } = useTheme();
  return (
    <div
      data-palette={palette}
      data-mode={resolvedMode}
      className={cn('bg-background text-foreground', className)}
    >
      {children}
    </div>
  );
}
