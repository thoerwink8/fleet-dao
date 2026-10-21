// 指标（#3509，照 Arco Pro，样稿 canvas/fd3.css `.kpis` `.kpi`）：一个标签（12px ink-2）加一个数字（24/600，等宽数字），
// 可带单位。不带图标、不带彩色圆底、不带说明、不可点（创始人拍的减法）；数字只在异常时上色（超标、出错红，停滞橙）。
// StatGrid 把一排指标摆成一行，指标之间一道竖线；放在区块（Section）里，自己不画卡片。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { anomalyInkClass, type LayoutTone } from './tone';

export function Stat({
  label,
  value,
  unit,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  /** 数字后面的小号单位（「个」「%」）。 */
  unit?: ReactNode;
  /** 数字的状态：只有异常上色（fail 红；stall、doubt 橙），别的照正文色。 */
  tone?: LayoutTone | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      data-tone={tone}
      data-stat
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-1 border-l border-line px-6 py-1 first:border-l-0 first:pl-1',
        // 手机上两个一行，不画竖线
        'max-md:basis-5/12 max-md:border-l-0 max-md:px-1 max-md:py-2',
        className,
      )}
    >
      <span className="text-meta text-ink-2">{label}</span>
      <span className={cn('num flex items-baseline gap-1 text-display text-ink', anomalyInkClass(tone))}>
        <span>{value}</span>
        {unit ? <span className="text-meta font-normal text-ink-3">{unit}</span> : null}
      </span>
    </div>
  );
}

/** 一排指标：桌面（md 起）一行平分、不折行；手机两个一行。 */
export function StatGrid({
  cols = 4,
  children,
  className,
}: {
  /** 几个指标（旧参数）。一行平分不靠它算，只写在 data-cols 上。 */
  cols?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-cols={cols} className={cn('flex flex-wrap items-stretch md:flex-nowrap', className)}>
      {children}
    </div>
  );
}
