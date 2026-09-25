import { CalendarClock, CircleX, ScanSearch, TimerOff } from 'lucide-react';
import { brand } from '#brand';
import { useJobs } from '../api/client';
import type { JobView } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel, Stat } from '../components/page';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { formatAgo, formatDateTime, formatDuration } from '../lib/format';
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

export default function Schedules() {
  const { data, error, isLoading } = useJobs();
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
    >
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="定时任务" value={count(jobs.length)} icon={CalendarClock} />
        <Stat
          label="上次失败"
          value={count(failed)}
          icon={CircleX}
          accent={failed ? 'text-ink-fail' : undefined}
        />
        <Stat
          label="上次没查全"
          value={count(unscanned)}
          icon={ScanSearch}
          hint="跑了，但一个都没扫到，或有一部分没查成"
          accent={unscanned ? 'text-ink-stall' : undefined}
        />
        <Stat
          label="过期"
          value={count(notFresh)}
          icon={TimerOff}
          hint="超过期望间隔没跑成，或从没跑成过"
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">任务</TableHead>
                <TableHead className="w-44">周期</TableHead>
                <TableHead>上次运行</TableHead>
                <TableHead className="w-36">上次跑成</TableHead>
                <TableHead className="w-20 pr-4 text-right">耗时</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => {
                const tone = rowTone(j);
                const r = j.lastRun;
                return (
                  <TableRow
                    key={j.id}
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
                            'absolute inset-y-0 left-0 w-[3px]',
                            tone === 'fail' ? 'bg-st-fail' : 'bg-st-stall',
                          )}
                        />
                      ) : null}
                      <div className="font-medium">{j.name}</div>
                      <div className="num text-xs text-muted-foreground">{j.id}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="num">{j.schedule}</div>
                      <div className="text-[11px] text-muted-foreground">
                        期望{everyText(j.expectEveryMinutes)}成功一次
                      </div>
                    </TableCell>
                    <TableCell className="max-w-72">
                      <span
                        className={cn(
                          'block truncate text-xs',
                          r?.outcome === 'failed' && 'font-medium text-ink-fail',
                          (r?.outcome === 'unscanned' || r?.outcome === 'partial') &&
                            'font-medium text-ink-stall',
                          r?.outcome === 'ok' && 'text-muted-foreground',
                        )}
                        title={outcomeText(j)}
                      >
                        {outcomeText(j)}
                      </span>
                      {r ? (
                        <span className="num text-[11px] text-faint">{formatAgo(r.startedAt, now)}开始</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {j.lastSuccessAt ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className={cn(
                                'num text-xs',
                                j.status !== 'fresh' && 'font-medium text-ink-stall',
                              )}
                            >
                              {formatAgo(j.lastSuccessAt, now)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{formatDateTime(j.lastSuccessAt)}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-ink-stall">{jobStatusLabel.never}</span>
                      )}
                      {j.status === 'overdue' ? (
                        <div className="text-[11px] text-ink-stall">{jobStatusLabel.overdue}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="num pr-4 text-right text-xs text-muted-foreground">
                      {r?.endedAt
                        ? formatDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt))
                        : r
                          ? '在跑'
                          : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
      <p className="mt-3 text-xs text-muted-foreground">
        定时任务的变化没有实时推送，这一页每 30 秒自己刷新一次。
      </p>
    </Page>
  );
}
