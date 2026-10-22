// 定时任务页（#3509 照 Arco 改版，样稿 canvas/Schedules.dc.html；原先是 #1914 路由页样板的写法）：一个区块一张表列全部定时任务。
// 区块头：定时任务加总数，右边「全部 / 有问题 N」筛选（本页内部状态，不进地址栏）。
// 一行：名字加一行灰字上次结果、状态（只一个）、周期、上次跑成的相对时间；点开看完整结果、开始时间、耗时、过期线。
// 读不到写没读成和原因（带重试），不画 0 冒充「没有失败」；读成过、刷新时失败，照旧画上一次读到的，顶上一条橙提示。
// 页面只拼 components/layout 的件，不写样式类（design 第三节、lint-design R13–R20）。
import { CalendarClock } from 'lucide-react';
import { useState } from 'react';
import { brand } from '#brand';
import { POLL_FAST_MS, useJobs } from '../api/client';
import { Button } from '../components/layout/button';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { LoadError, LoadingRows, LoadStale } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { Tag } from '../components/layout/tag';
import { problemsFirst, rowTone, ScheduleTable } from '../components/schedule-row';
import { formatAgo, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';

export function meta() {
  return [{ title: brand.title('定时任务') }];
}

/** 定时任务按 POLL_FAST_MS 重拉。超过 5 分钟还没再读成，刷新条标「数据已过期」（正常间隔里不标）。 */
const JOBS_STALE_AFTER_MS = 5 * TIME.MIN;

type View = 'all' | 'bad';

export default function Schedules() {
  const { data, error, isLoading, refetch, isFetching, dataUpdatedAt } = useJobs();
  const now = useNow();
  const [view, setView] = useState<View>('all');
  const retry = () => void refetch();
  const page = {
    title: '定时任务',
    breadcrumb: (
      <>
        <Button variant="text" size="xs" href="/france">
          法国
        </Button>
        <span aria-hidden>/</span>
      </>
    ),
    description: '后台定时跑的活，各自上次跑得怎么样。',
    detail: (
      <>
        <p>
          额度读取、巡检、对账、备份……每个都记下上次跑成的时间。「查了 0 个问题」和「这次没查成」分开显示。
        </p>
        <p>出问题的排在最前：失败标红，没查全、过期标橙。点一行看完整结果、开始时间、耗时和过期线。</p>
        <p>定时任务的变化没有实时推送，这一页每 {POLL_FAST_MS / 1000} 秒自己刷新一次。</p>
      </>
    ),
    refresh: {
      onRefresh: retry,
      isFetching,
      dataUpdatedAt,
      staleAfterMs: JOBS_STALE_AFTER_MS,
    },
  };

  // 从没读成：只写没读成和原因（带重试），不画表，不拿 0 冒充「没有失败」。
  if (!data) {
    return (
      <Page {...page}>
        {error ? (
          <LoadError what="定时任务" error={error} onRetry={retry} />
        ) : isLoading ? (
          <Section title="定时任务">
            <LoadingRows rows={6} />
          </Section>
        ) : (
          <LoadError what="定时任务" error={new Error('没有回数据')} onRetry={retry} />
        )}
      </Page>
    );
  }

  const jobs = data.jobs;
  const bad = jobs.filter((j) => rowTone(j) !== null);
  const shown = problemsFirst(view === 'bad' ? bad : jobs);
  return (
    <Page {...page}>
      <Stack>
        {/* 读成过、刷新时失败：照旧画上一次读到的，顶上一条提示带重试 */}
        {error ? (
          <LoadStale
            what="定时任务"
            error={error}
            when={formatAgo(new Date(dataUpdatedAt).toISOString(), now)}
            expired={Date.now() - dataUpdatedAt > JOBS_STALE_AFTER_MS}
            onRetry={retry}
          />
        ) : null}
        {jobs.length === 0 ? (
          <Section title="定时任务">
            <EmptyState icon={CalendarClock} title="还没有定时任务" />
          </Section>
        ) : (
          <Section
            flush
            title={
              <>
                定时任务
                <Tag>{jobs.length}</Tag>
              </>
            }
            actions={
              <FilterTabs<View>
                aria-label="筛选"
                mode="toggle"
                variant="segmented"
                value={view}
                onChange={setView}
                items={[
                  { id: 'all', label: '全部' },
                  { id: 'bad', label: `有问题 ${bad.length}` },
                ]}
              />
            }
          >
            {shown.length === 0 ? (
              <EmptyState size="inline" title="没有出问题的定时任务" />
            ) : (
              <ScheduleTable jobs={shown} now={now} />
            )}
          </Section>
        )}
      </Stack>
    </Page>
  );
}
