import { CalendarClock, CircleX, ScanSearch, TimerOff } from 'lucide-react';
import { brand } from '#brand';
import { useJobs } from '../api/client';
import type { JobView } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel, Stat } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { formatAgo, formatDateTime, formatDuration, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { everyText, jobStatusLabel, outcomeText } from '../lib/schedule';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('定时任务') }];
}

/** 一行该用什么颜色提醒：失败红，没查成、只查了一部分、过期黄。 */
function rowTone(j: JobView): 'fail' | 'stall' | null {
  if (j.lastRun?.outcome === 'failed') return 'fail';
  if (j.lastRun?.outcome === 'unscanned' || j.lastRun?.outcome === 'partial' || j.status !== 'fresh')
    return 'stall';
  return null;
}

/** 定时任务每 30 秒重拉一次。超过 5 分钟还没再读成，刷新条标「数据已过期」（正常间隔里不标）。 */
const JOBS_STALE_AFTER_MS = 5 * TIME.MIN;

/** 上次跑成（主行）+ 上次开始时间（副行），合成一列，少占横向宽度（#1753）。 */
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

function Outcome({ j, truncate }: { j: JobView; truncate?: boolean }) {
  const r = j.lastRun;
  return (
    <span
      className={cn(
        'block text-xs',
        truncate && 'truncate',
        r?.outcome === 'failed' && 'font-medium text-ink-fail',
        (r?.outcome === 'unscanned' || r?.outcome === 'partial') && 'font-medium text-ink-stall',
        r?.outcome === 'ok' && 'text-muted-foreground',
      )}
      title={outcomeText(j)}
    >
      {outcomeText(j)}
    </span>
  );
}

function Duration({ j }: { j: JobView }) {
  const r = j.lastRun;
  if (r?.endedAt) return formatDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt));
  if (r) return '在跑';
  return '—';
}

/** 窄屏：每个任务一张卡片，避免横向滚动（#1753）。 */
function JobCard({ j, now }: { j: JobView; now: number }) {
  const tone = rowTone(j);
  const r = j.lastRun;
  return (
    <li
      data-outcome={r?.outcome ?? (r ? 'running' : 'never')}
      data-status={j.status}
      className={cn(
        'relative px-4 py-3',
        tone === 'fail' && 'bg-st-fail/[0.06]',
        tone === 'stall' && 'bg-st-stall/[0.07]',
      )}
    >
      {tone ? (
        <span
          aria-hidden
          className={cn('absolute inset-y-0 left-0 w-rail', tone === 'fail' ? 'bg-st-fail' : 'bg-st-stall')}
        />
      ) : null}
      <div className="font-medium">{j.name}</div>
      <div className="num text-xs text-muted-foreground">{j.id}</div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div className="min-w-0">
          <dt className="text-caption text-muted-foreground">周期</dt>
          <dd className="num mt-0.5">{j.schedule}</dd>
          <dd className="text-caption text-muted-foreground">
            期望{everyText(j.expectEveryMinutes)}成功一次
          </dd>
        </div>
        <div className="min-w-0 text-right">
          <dt className="text-caption text-muted-foreground">耗时</dt>
          <dd className="num mt-0.5 text-muted-foreground">
            <Duration j={j} />
          </dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-caption text-muted-foreground">上次运行</dt>
          <dd className="mt-0.5">
            <Outcome j={j} />
          </dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-caption text-muted-foreground">上次跑成</dt>
          <dd className="mt-0.5">
            <LastSuccess j={j} now={now} />
          </dd>
        </div>
      </dl>
    </li>
  );
}

function JobRow({ j, now }: { j: JobView; now: number }) {
  const tone = rowTone(j);
  const r = j.lastRun;
  return (
    <TableRow
      data-outcome={r?.outcome ?? (r ? 'running' : 'never')}
      data-status={j.status}
      className={cn(
        'relative',
        tone === 'fail' && 'bg-st-fail/[0.06] hover:bg-st-fail/[0.09]',
        tone === 'stall' && 'bg-st-stall/[0.07] hover:bg-st-stall/[0.1]',
      )}
    >
      <TableCell className="relative pl-4">
        {tone ? (
          <span
            aria-hidden
            className={cn(
              // 左侧竖线用 w-rail。
              'absolute inset-y-0 left-0 w-rail',
              tone === 'fail' ? 'bg-st-fail' : 'bg-st-stall',
            )}
          />
        ) : null}
        <div className="font-medium">{j.name}</div>
        <div className="num text-xs text-muted-foreground">{j.id}</div>
      </TableCell>
      <TableCell className="text-xs">
        <div className="num">{j.schedule}</div>
        {/* 周期说明换成 text-caption。 */}
        <div className="text-caption text-muted-foreground">
          期望{everyText(j.expectEveryMinutes)}成功一次
        </div>
      </TableCell>
      <TableCell className="min-w-0 max-w-64">
        <Outcome j={j} truncate />
      </TableCell>
      <TableCell className="w-36">
        <LastSuccess j={j} now={now} />
      </TableCell>
      <TableCell className="num pr-4 text-right text-xs text-muted-foreground">
        <Duration j={j} />
      </TableCell>
    </TableRow>
  );
}

export default function Schedules() {
  const { data, error, isLoading, refetch, isFetching, dataUpdatedAt } = useJobs();
  const now = useNow();
  const jobs = data?.jobs ?? [];
  const failed = jobs.filter((j) => j.lastRun?.outcome === 'failed').length;
  const unscanned = jobs.filter(
    (j) => j.lastRun?.outcome === 'unscanned' || j.lastRun?.outcome === 'partial',
  ).length;
  const notFresh = jobs.filter((j) => j.status !== 'fresh').length;
  // 没读到就显示「—」，不拿 0 冒充「没有失败」。
  const count = (n: number) => (data ? n : '—');

  return (
    <Page
      title="定时任务"
      description="额度读取、巡检、对账、备份……每个都记下上次跑成的时间。「查了 0 个问题」和「这次没查成」分开显示。"
      actions={
        <RefreshBar
          onRefresh={() => void refetch()}
          isFetching={isFetching}
          dataUpdatedAt={dataUpdatedAt}
          staleAfterMs={JOBS_STALE_AFTER_MS}
        />
      }
    >
      <div className="mb-4 grid grid-cols-2 items-stretch gap-3 md:grid-cols-4">
        <Stat className="h-full min-w-0" label="定时任务" value={count(jobs.length)} icon={CalendarClock} />
        <Stat
          className="h-full min-w-0"
          label="上次失败"
          value={count(failed)}
          icon={CircleX}
          accent={failed ? 'text-ink-fail' : undefined}
        />
        <Stat
          className="h-full min-w-0"
          label="上次没查全"
          value={count(unscanned)}
          icon={ScanSearch}
          hint="跑了，但一个都没扫到，或有一部分没查成"
          wrapHint
          accent={unscanned ? 'text-ink-stall' : undefined}
        />
        <Stat
          className="h-full min-w-0"
          label="过期"
          value={count(notFresh)}
          icon={TimerOff}
          hint="超过期望间隔没跑成，或从没跑成过"
          wrapHint
          accent={notFresh ? 'text-ink-stall' : undefined}
        />
      </div>
      {error ? (
        <div className="mb-3">
          <LoadError what="定时任务" error={error} />
        </div>
      ) : null}
      <Panel bodyClassName="p-0">
        {isLoading ? (
          <div className="p-4">
            <LoadingRows rows={6} />
          </div>
        ) : !data ? (
          <p className="px-4 py-10 text-center text-sm text-ink-fail">没读到定时任务，说不准它们跑得怎么样</p>
        ) : jobs.length === 0 ? (
          <Empty icon={CalendarClock} title="还没有定时任务" />
        ) : (
          <>
            {/* lg 以下改卡片，避免窄屏横向滚动；1366 起是表格（#1753）。 */}
            <ul className="divide-y lg:hidden">
              {jobs.map((j) => (
                <JobCard key={j.id} j={j} now={now} />
              ))}
            </ul>
            <div className="hidden lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">任务</TableHead>
                    <TableHead className="w-40">周期</TableHead>
                    <TableHead>上次运行</TableHead>
                    <TableHead className="w-36">上次跑成</TableHead>
                    <TableHead className="w-16 pr-4 text-right">耗时</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((j) => (
                    <JobRow key={j.id} j={j} now={now} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </Panel>
      <p className="mt-3 text-xs text-muted-foreground">
        定时任务的变化没有实时推送，这一页每 30 秒自己刷新一次。
      </p>
    </Page>
  );
}
