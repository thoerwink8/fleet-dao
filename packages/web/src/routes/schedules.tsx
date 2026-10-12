// 定时任务页（照路由页样板重做，#1914 的思路）：顶上一块标题块说最要紧的一句，下面一个区块列全部定时任务。
// 一行：名字加一个状态、一行灰字（上次结果 · 周期）、右边上次跑成的相对时间；点开看周期、完整结果、开始时间、耗时、编号。

import { errMessage } from '@fleet-dao/shared/util';
import { CalendarClock } from 'lucide-react';
import { brand } from '#brand';
import { useJobs } from '../api/client';
import { EmptyState } from '../components/layout/empty-state';
import { List } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Section, SectionGrid } from '../components/layout/section';
import { problemsFirst, ScheduleRow, SchedulesHero } from '../components/schedule-row';
import { TIME } from '../lib/format';
import { useNow } from '../lib/hooks';

export function meta() {
  return [{ title: brand.title('定时任务') }];
}

/** 定时任务每 30 秒重拉一次。超过 5 分钟还没再读成，刷新条标「数据已过期」（正常间隔里不标）。 */
const JOBS_STALE_AFTER_MS = 5 * TIME.MIN;

const DETAIL = (
  <div className="space-y-2">
    <p>额度读取、巡检、对账、备份……每个都记下上次跑成的时间。「查了 0 个问题」和「这次没查成」分开显示。</p>
    <p>出问题的排在最前：失败标红，没查全、过期标黄。点一行看周期、完整结果、开始时间、耗时和编号。</p>
    <p>定时任务的变化没有实时推送，这一页每 30 秒自己刷新一次。</p>
  </div>
);

export default function Schedules() {
  const { data, error, isLoading, refetch, isFetching, dataUpdatedAt } = useJobs();
  const now = useNow();
  const page = {
    title: '定时任务',
    description: '后台定时跑的活，各自上次跑得怎么样。',
    detail: DETAIL,
    refresh: {
      onRefresh: () => void refetch(),
      isFetching,
      dataUpdatedAt,
      staleAfterMs: JOBS_STALE_AFTER_MS,
    },
  };

  // 从没读成：只写没读成和原因（带重试），不画摘要，不拿 0 冒充「没有失败」。
  if (!data) {
    return (
      <Page {...page}>
        {error ? (
          <LoadError what="定时任务" error={error} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <LoadingRows rows={6} />
        ) : (
          <LoadError what="定时任务" error={new Error('没有回数据')} onRetry={() => void refetch()} />
        )}
      </Page>
    );
  }

  const jobs = data.jobs;
  return (
    <Page {...page}>
      <SectionGrid cols={1}>
        {jobs.length > 0 ? <SchedulesHero jobs={jobs} now={now} /> : null}
        <div className="space-y-3">
          {/* 读成过、刷新时失败：照旧画上一次读到的，顶上一条横幅带重试 */}
          {error ? (
            <LoadError
              text={`定时任务刷新没读成，下面是上一次读到的：${errMessage(error)}`}
              error={error}
              onRetry={() => void refetch()}
            />
          ) : null}
          <Section flush>
            {jobs.length === 0 ? (
              <EmptyState icon={CalendarClock} title="还没有定时任务" />
            ) : (
              <List data-job-list>
                {problemsFirst(jobs).map((j) => (
                  <ScheduleRow key={j.id} j={j} now={now} />
                ))}
              </List>
            )}
          </Section>
        </div>
      </SectionGrid>
    </Page>
  );
}
