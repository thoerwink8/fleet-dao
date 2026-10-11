import { CalendarClock, CircleX, ScanSearch, TimerOff } from 'lucide-react';
import { brand } from '#brand';
import { useJobs } from '../api/client';
import { JobListHead, JobListRow } from '../components/job-row';
import { Empty, LoadError, LoadingRows, Page, Panel, Stat } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { TIME } from '../lib/format';
import { useNow } from '../lib/hooks';

export function meta() {
  return [{ title: brand.title('定时任务') }];
}

/** 定时任务每 30 秒重拉一次。超过 5 分钟还没再读成，刷新条标「数据已过期」（正常间隔里不标）。 */
const JOBS_STALE_AFTER_MS = 5 * TIME.MIN;

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
            <JobListHead />
            <ul className="divide-y" data-job-list>
              {jobs.map((j) => (
                <JobListRow key={j.id} j={j} now={now} />
              ))}
            </ul>
          </>
        )}
      </Panel>
      <p className="mt-3 text-xs text-muted-foreground">
        定时任务的变化没有实时推送，这一页每 30 秒自己刷新一次。
      </p>
    </Page>
  );
}
