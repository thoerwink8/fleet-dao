import { CalendarClock } from 'lucide-react';
import { brand } from '#brand';
import { useJobs } from '../api/client';
import { JobListHead, JobListRow, rowTone } from '../components/job-row';
import { EmptyState } from '../components/layout/empty-state';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { StatusBadge } from '../components/layout/status-badge';
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
  // 异常行排最前（失败、再是没查全 / 过期），其余保持原来的先后
  const rowRank = (j: (typeof jobs)[number]): number => {
    const tone = rowTone(j);
    return tone === 'fail' ? 0 : tone === 'stall' ? 1 : 2;
  };
  const ordered = [...jobs].sort((a, b) => rowRank(a) - rowRank(b));
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
      {/* 统计压成一条摘要：只列不是 0 的，全是 0 就一句「都正常」，不拿三张 0 占半屏（#1902）。 */}
      <p
        className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-body text-muted-foreground"
        data-job-summary
      >
        <span>
          共 <span className="num font-medium text-foreground">{count(jobs.length)}</span> 个定时任务
        </span>
        {!data ? null : failed + unscanned + notFresh === 0 ? (
          <StatusBadge tone="done" label="都正常" />
        ) : (
          <>
            {failed > 0 ? <StatusBadge tone="fail" label={`上次失败 ${failed}`} /> : null}
            {unscanned > 0 ? (
              <span title="跑了，但一个都没扫到，或有一部分没查成">
                <StatusBadge tone="stall" label={`没查全 ${unscanned}`} />
              </span>
            ) : null}
            {notFresh > 0 ? (
              <span title="超过期望间隔没跑成，或从没跑成过">
                <StatusBadge tone="stall" label={`过期 ${notFresh}`} />
              </span>
            ) : null}
          </>
        )}
      </p>
      {error ? (
        <div className="mb-3">
          <LoadError what="定时任务" error={error} />
        </div>
      ) : null}
      <Section flush>
        {isLoading ? (
          <div className="p-4">
            <LoadingRows rows={6} />
          </div>
        ) : !data ? (
          <p className="px-4 py-10 text-center text-body text-ink-fail">
            没读到定时任务，说不准它们跑得怎么样
          </p>
        ) : jobs.length === 0 ? (
          <EmptyState icon={CalendarClock} title="还没有定时任务" />
        ) : (
          <>
            <JobListHead />
            <ul className="divide-y" data-job-list>
              {ordered.map((j) => (
                <JobListRow key={j.id} j={j} now={now} fullOutcome={rowTone(j) !== null} />
              ))}
            </ul>
          </>
        )}
      </Section>
      <p className="mt-3 text-meta text-muted-foreground">
        定时任务的变化没有实时推送，这一页每 30 秒自己刷新一次。
      </p>
    </Page>
  );
}
