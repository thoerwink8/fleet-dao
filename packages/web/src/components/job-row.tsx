// 定时任务的列表行（#1805）：定时任务页和法国页共用。一行：状态点、名字、上次结果、上次跑成的相对时间；
// 点开才看周期、完整结果、开始时间、耗时、编号。失败红、没查全 / 过期黄（判法同原来的表）。
import type { JobView } from '../api/types';
import { formatAgo, formatDateTime, formatDuration } from '../lib/format';
import { everyText, jobStatusLabel, outcomeText } from '../lib/schedule';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';
import { KeyValue } from './layout/key-value';
import { ListRow } from './layout/list';
import { StatusDot } from './layout/status-badge';
import { Tag } from './layout/tag';
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
            <span className={cn('num text-meta', j.status !== 'fresh' && 'font-medium text-ink-stall')}>
              {formatAgo(j.lastSuccessAt, now)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{formatDateTime(j.lastSuccessAt)}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-meta text-ink-stall">{jobStatusLabel.never}</span>
      )}
      {j.status === 'overdue' ? (
        <div className="text-meta text-ink-stall">{jobStatusLabel.overdue}</div>
      ) : null}
      {r ? (
        <div className="num text-meta text-muted-foreground">{formatAgo(r.startedAt, now)}开始</div>
      ) : null}
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

/** fullOutcome：上次结果写全、可换行，不截断（定时任务页把异常行置顶时用，#1902）。 */
export function JobListRow({ j, now, fullOutcome }: { j: JobView; now: number; fullOutcome?: boolean }) {
  const tone = rowTone(j);
  const r = j.lastRun;
  return (
    <ListRow
      expandable
      data-outcome={r?.outcome ?? (r ? 'running' : 'never')}
      data-status={j.status}
      rail={tone ?? undefined}
      summary={
        <>
          <StatusDot tone={dotTone(j)} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 truncate text-body font-medium" title={j.id}>
                {j.name}
              </span>
              {j.status === 'overdue' ? (
                <span title={jobStatusLabel.overdue} className="shrink-0">
                  <Tag tone="stall">过期</Tag>
                </span>
              ) : null}
            </span>
            {/* 宽屏有单独的「上次运行」列；窄屏那一列藏起来，结果挪到名字下面一行，不让失败、没查全藏在展开里。 */}
            <span className={cn('block text-meta md:hidden', !fullOutcome && 'truncate', outcomeClass(j))}>
              {outcomeText(j)}
            </span>
          </span>
          <span
            className={cn(
              'hidden w-64 shrink-0 text-meta md:block',
              !fullOutcome && 'truncate',
              outcomeClass(j),
            )}
            title={outcomeText(j)}
          >
            {outcomeText(j)}
          </span>
          <span
            className={cn(
              'num w-20 shrink-0 text-right text-meta text-muted-foreground',
              j.status !== 'fresh' && 'font-medium text-ink-stall',
            )}
          >
            {j.lastSuccessAt ? formatAgo(j.lastSuccessAt, now) : jobStatusLabel.never}
          </span>
          <span className="num hidden w-14 shrink-0 text-right text-meta text-muted-foreground sm:block">
            {durationText(j)}
          </span>
        </>
      }
    >
      <KeyValue
        layout="grid"
        cols={4}
        items={[
          {
            label: '周期',
            value: <span className="num">{j.schedule}</span>,
            hint: `期望${everyText(j.expectEveryMinutes)}成功一次`,
          },
          {
            label: '上次运行',
            value: outcomeText(j),
            ...(r?.outcome === 'failed' ? { tone: 'fail' as const } : {}),
            ...(r?.outcome === 'unscanned' || r?.outcome === 'partial' ? { tone: 'stall' as const } : {}),
          },
          { label: '上次跑成', value: <LastSuccess j={j} now={now} /> },
          { label: '耗时', value: <span className="num">{durationText(j)}</span> },
          { label: '编号', value: j.id, mono: true },
        ]}
      />
    </ListRow>
  );
}

/** 列表上方的列名（和行里各列同宽；窄屏只剩名字和时间，不画）。 */
export function JobListHead() {
  return (
    <div
      aria-hidden
      className="hidden items-center gap-3 border-b bg-muted px-4 py-1.5 text-meta text-muted-foreground sm:flex"
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
