// 进度条（参数名照 antd，样子照 canvas/fd3.css 的 .progress .progress-mark）。
// 条是蓝的；到了 warn 线变橙、到了 fail 线变红（颜色只给异常，没有绿色）。宽度变化过渡 300。
// percent 收数字或 Read<number>：没读到不画条、写「没读到」（悬停给原因），不会画成 0%。
import { type Read, UNREAD_TEXT } from '../../lib/read';
import { cn } from '../../lib/utils';

export interface ProgressThresholds {
  /** 到这个百分比变橙（含）。默认 75。 */
  warn?: number;
  /** 到这个百分比变红（含）。默认 90。 */
  fail?: number;
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));

export function Progress({
  percent,
  thresholds,
  mark,
  label,
  'aria-label': ariaLabel,
}: {
  /** 0–100。读失败传 { ok: false, reason }。 */
  percent: number | Read<number>;
  /** 变色线；传 {} 不变色（比如不是「越满越糟」的进度）。默认 { warn: 75, fail: 90 }。 */
  thresholds?: ProgressThresholds;
  /** 按时间该用到这里：条上的一道竖线（0–100），用量超过它就是用快了。 */
  mark?: number;
  /** 条右边的字；不写＝「42%」。 */
  label?: string;
  'aria-label'?: string;
}) {
  const t = thresholds ?? { warn: 75, fail: 90 };
  const read: Read<number> = typeof percent === 'number' ? { ok: true, value: percent } : percent;
  if (!read.ok) {
    return (
      <div data-progress="unread" className="flex min-w-0 items-center gap-3">
        <div className="relative h-1.5 min-w-20 flex-1 rounded-full bg-fill-3" />
        <span title={read.reason} className="min-w-11 text-right text-body whitespace-nowrap text-ink-3">
          {UNREAD_TEXT}
        </span>
      </div>
    );
  }
  const pct = clamp(Math.round(read.value));
  const level =
    t.fail !== undefined && pct >= t.fail ? 'fail' : t.warn !== undefined && pct >= t.warn ? 'warn' : 'ok';
  return (
    <div data-progress={level} className="flex min-w-0 items-center gap-3">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        className="relative h-1.5 min-w-20 flex-1 rounded-full bg-fill-3"
      >
        <div
          data-progress-fill
          style={{ width: `${pct}%` }}
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-all duration-300 ease-arco',
            level === 'fail' ? 'bg-fail' : level === 'warn' ? 'bg-warn' : 'bg-brand',
          )}
        />
        {mark !== undefined ? (
          <span
            data-progress-mark
            title={`按时间该用到 ${Math.round(clamp(mark))}%`}
            style={{ left: `${clamp(mark)}%` }}
            className="absolute -top-1 -ml-px h-3.5 w-0.5 rounded-sm bg-ink"
          />
        ) : null}
      </div>
      <span className="min-w-11 text-right text-body whitespace-nowrap text-ink">{label ?? `${pct}%`}</span>
    </div>
  );
}
