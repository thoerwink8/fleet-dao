// 定时任务的列表行（#1805）：定时任务页和法国页共用。一行：状态点、名字、上次结果、上次跑成的相对时间；
// 点开才看周期、完整结果、开始时间、耗时、编号。失败红、没查全 / 过期黄（判法同原来的表）。
import type { JobView } from '../api/types';
import { formatAgo, formatDateTime, formatDuration } from '../lib/format';
import { everyText, jobStatusLabel, outcomeText } from '../lib/schedule';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';
import { ExpandRow } from './expand-row';
import { StatusDot } from './status';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/** 一行该用什么颜色提醒：失败红，没查成、只查了一部分、过期黄。 */
export function rowTone(j: JobView): 'fail' | 'stall' | null {
  if (j.lastRun?.outcome === 'failed') return 'fail';
  if (j.lastRun?.outcome === 'unscanned' || j.lastRun?.outcome === 'partial' || j.status !== 'fresh')
    return 'stall';
  return null;
}

/** 状态点：失败红、没查全 / 过期黄、在跑蓝、其余绿。 */
function dotTone(j: JobView): Tone {
  const tone = rowTone(j);
  if (tone === 'fail') return 'fail';
  if (tone === 'stall') return 'stall';
  if (j.lastRun && !j.lastRun.endedAt) return 'run';
  return 'done';
}

/** 上次跑成（主行）+ 上次开始时间（副行），合成一块（#1753）。 */
function LastSuccess({ j, now }: { j: JobView; now: number }) {
  const r = j.lastRun;
  return (
    <div data-last-success>
      {j.lastSuccessAt ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn('num text-xs', j.status !== 'fresh' && 'font-medium text-ink-stall')}>
              {formatAgo(j.lastSuccessAt, now)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{formatDateTime(j.lastSuccessAt)}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-ink-stall">{jobStatusLabel.never}</span>
      )}
      {j.status === 'overdue' ? (
        <div className="text-caption text-ink-stall">{jobStatusLabel.overdue}</div>
      ) : null}
      {r ? <div className="num text-caption text-faint">{formatAgo(r.startedAt, now)}开始</div> : null}
    </div>
  );
}

function outcomeClass(j: JobView): string {
  const r = j.lastRun;
  return cn(
    r?.outcome === 'failed' && 'font-medium text-ink-fail',
    (r?.outcome === 'unscanned' || r?.outcome === 'partial') && 'font-medium text-ink-stall',
    r?.outcome === 'ok' && 'text-muted-foreground',
  );
}

function durationText(j: JobView): string {
  const r = j.lastRun;
  if (r?.endedAt) return formatDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt));
  if (r) return '在跑';
  return '—';
}

export function JobListRow({ j, now }: { j: JobView; now: number }) {
  const tone = rowTone(j);
  const r = j.lastRun;
  return (
    <ExpandRow
      data-outcome={r?.outcome ?? (r ? 'running' : 'never')}
      data-status={j.status}
      className={cn(tone === 'fail' && 'bg-st-fail/[0.06]', tone === 'stall' && 'bg-st-stall/[0.07]')}
      rail={tone ? (tone === 'fail' ? 'bg-st-fail' : 'bg-st-stall') : undefined}
      summary={
        <>
          <StatusDot tone={dotTone(j)} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 truncate text-sm font-medium" title={j.id}>
                {j.name}
              </span>
              {j.status === 'overdue' ? (
                <span
                  className="shrink-0 rounded bg-st-stall/14 px-1 text-micro leading-4 text-ink-stall"
                  title={jobStatusLabel.overdue}
                >
                  过期
                </span>
              ) : null}
            </span>
            {/* 宽屏有单独的「上次运行」列；窄屏那一列藏起来，结果挪到名字下面一行，不让失败、没查全藏在展开里。 */}
            <span className={cn('block truncate text-caption md:hidden', outcomeClass(j))}>
              {outcomeText(j)}
            </span>
          </span>
          <span
            className={cn('hidden w-64 shrink-0 truncate text-xs md:block', outcomeClass(j))}
            title={outcomeText(j)}
          >
            {outcomeText(j)}
          </span>
          <span
            className={cn(
              'num w-20 shrink-0 text-right text-xs text-muted-foreground',
              j.status !== 'fresh' && 'font-medium text-ink-stall',
            )}
          >
            {j.lastSuccessAt ? formatAgo(j.lastSuccessAt, now) : jobStatusLabel.never}
          </span>
          <span className="num hidden w-14 shrink-0 text-right text-xs text-muted-foreground sm:block">
            {durationText(j)}
          </span>
        </>
      }
    >
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-caption text-muted-foreground">周期</dt>
          <dd className="num mt-0.5">{j.schedule}</dd>
          <dd className="text-caption text-muted-foreground">
            期望{everyText(j.expectEveryMinutes)}成功一次
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-1 lg:col-span-2">
          <dt className="text-caption text-muted-foreground">上次运行</dt>
          <dd className={cn('mt-0.5 break-words', outcomeClass(j))}>{outcomeText(j)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-muted-foreground">上次跑成</dt>
          <dd className="mt-0.5">
            <LastSuccess j={j} now={now} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-muted-foreground">耗时</dt>
          <dd className="num mt-0.5">{durationText(j)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-muted-foreground">编号</dt>
          <dd className="num mt-0.5 break-all">{j.id}</dd>
        </div>
      </dl>
    </ExpandRow>
  );
}

/** 列表上方的列名（和行里各列同宽；窄屏只剩名字和时间，不画）。 */
export function JobListHead() {
  return (
    <div
      aria-hidden
      className="hidden items-center gap-3 border-b bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground sm:flex"
    >
      <span className="size-2 shrink-0" />
      <span className="min-w-0 flex-1">任务</span>
      <span className="hidden w-64 shrink-0 md:block">上次运行</span>
      <span className="w-20 shrink-0 text-right">上次跑成</span>
      <span className="w-14 shrink-0 text-right">耗时</span>
      <span className="size-4 shrink-0" />
    </div>
  );
}
