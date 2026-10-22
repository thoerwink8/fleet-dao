// 近 N 次探测的格子（样子照 canvas/fd3.css 的 .cells .cell）。
// 通＝灰格（--line-2），没探＝空心框，警告＝橙，失败＝红；选中的一格外面一圈黑框。
// 每格都有 aria-label 和悬停字（颜色不是唯一的信息）。传 onSelect 格子才能点。不收 className 和 style。
import { cn } from '../../lib/utils';

export type ProbeResult = 'ok' | 'none' | 'warn' | 'fail';

export interface ProbeCell {
  result: ProbeResult;
  /** 这一格说什么：「10:42 通过」。读屏和悬停用。 */
  label: string;
  /** 这一格的编号（探测记录的号）：写进 data-cell，页面和测试靠它认格子。 */
  id?: number | string;
  /** 比颜色更细的分类（通过、额度耗尽、疑似换模型……）：写进 data-kind；颜色只有四档。 */
  kind?: string;
}

const CELL: Record<ProbeResult, string> = {
  ok: 'bg-line-2',
  none: 'bg-transparent ring-1 ring-inset ring-line-2',
  warn: 'bg-warn',
  fail: 'bg-fail',
};

export function ProbeCells({
  items,
  selected,
  onSelect,
  summary,
}: {
  items: readonly ProbeCell[];
  /** 选中第几格（从 0 数）。 */
  selected?: number | null;
  onSelect?: (index: number) => void;
  /** 只做展示的整条（手机上格子太窄点不准）：整条是一张图，读屏念这一句，格子不单独报。 */
  summary?: string;
}) {
  const display = summary !== undefined && !onSelect;
  return (
    <div
      {...(display
        ? { role: 'img', 'aria-label': summary, 'data-strip-display': 'true' }
        : { role: 'group', 'aria-label': '近几次探测' })}
      className="flex h-6 items-stretch gap-0.5"
    >
      {items.map((it, i) => {
        const on = selected === i;
        const cls = cn(
          'max-w-2 min-w-1 flex-1 rounded-sm',
          CELL[it.result],
          on && 'outline-2 outline-offset-1 outline-ink',
        );
        return onSelect ? (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: 格子的身份就是第几次。
            key={i}
            type="button"
            data-result={it.result}
            {...(it.id !== undefined ? { 'data-cell': it.id } : {})}
            {...(it.kind !== undefined ? { 'data-kind': it.kind } : {})}
            aria-label={it.label}
            aria-pressed={on}
            title={it.label}
            onClick={() => onSelect(i)}
            className={cn(cls, 'cursor-pointer border-0 p-0')}
          />
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 格子的身份就是第几次。
            key={i}
            data-result={it.result}
            {...(it.id !== undefined ? { 'data-cell': it.id } : {})}
            {...(it.kind !== undefined ? { 'data-kind': it.kind } : {})}
            {...(it.label === '' || display
              ? { 'aria-hidden': true }
              : { role: 'img', 'aria-label': it.label })}
            {...(it.label !== '' ? { title: it.label } : {})}
            className={cls}
          />
        );
      })}
    </div>
  );
}
