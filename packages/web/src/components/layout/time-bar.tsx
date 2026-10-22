// 时间条（#3533，任务页过程顶上那条）：一段一个按钮，宽度按 weight 比例，窄的也留一点；失败红、在跑蓝、其余灰。
// 点一段回调 onPick。意思靠 aria-label 和悬停传，颜色只是辅助。不收 className 和 style。
import { cn } from '../../lib/utils';

export interface TimeBarItem {
  id: string;
  /** 宽度权重（用时毫秒或比例，页面先过 barWeights 保底）。 */
  weight: number;
  state?: 'idle' | 'run' | 'fail';
  /** 屏幕阅读器读的话。 */
  label: string;
  /** 悬停话。 */
  title?: string;
}

const FILL = { idle: 'bg-ink-3', run: 'bg-st-run', fail: 'bg-st-fail' } as const;

export function TimeBar({
  items,
  label,
  onPick,
}: {
  items: readonly TimeBarItem[];
  /** 整条的名字（「每一笔各占多久」）。 */
  label: string;
  onPick: (id: string) => void;
}) {
  return (
    <ul className="flex h-2 gap-px overflow-hidden rounded-full" aria-label={label} data-time-bar>
      {items.map((it) => (
        <li key={it.id} className="flex min-w-1" style={{ flex: `${it.weight} 1 0` }}>
          <button
            type="button"
            onClick={() => onPick(it.id)}
            title={it.title ?? it.label}
            aria-label={it.label}
            data-bar-item={it.id}
            data-state={it.state ?? 'idle'}
            className={cn(
              'w-full outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-brand-hover',
              FILL[it.state ?? 'idle'],
            )}
          />
        </li>
      ))}
    </ul>
  );
}
