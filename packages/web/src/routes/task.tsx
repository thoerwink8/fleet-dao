// 任务页（/tasks/:taskId）：一张单走了哪几段、每段每个模型花了多久、多少 token 和钱（#216）；动手、验收各用哪个模型，
// 能在这里指定或回到自动（驾驶舱改版 2026-10-07，components/task-model-pins.tsx）。执行体没报花费的按目录单价估、标「估算」。
// 主页「在跑的」卡片、「要你拍的」都链到这里。三段的单读 runs 表的流水（segmentRuns、usage.bySegment）；
// 老流程的单照旧是会话时间线加「时间与用量」。读不到的写「没读到」和原因，不写 0。

import { ArrowLeft, ListChecks } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { brand } from '#brand';
import { useRouting, useTaskDetail } from '../api/client';
import type { TaskDetail } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RepoLink } from '../components/repo-link';
import { RunTimeline } from '../components/run-timeline';
import { SegmentBreakdown, SegmentRunList, SegmentStats } from '../components/segment-usage';
import { StatusChip } from '../components/status';
import { TaskModelPins } from '../components/task-model-pins';
import { Button } from '../components/ui/button';
import { UsagePanel } from '../components/usage';
import { canSee, isDemo } from '../demo/access';
import { NotOpen } from '../demo/views';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { isTaskFinished, taskStateLabel, taskTone } from '../lib/status';

export function meta() {
  return [{ title: brand.title('任务') }];
}

function Back() {
  return (
    <Button asChild size="sm" variant="ghost" className="h-7">
      <Link to="/">
        <ArrowLeft className="size-3.5" aria-hidden />
        回主页
      </Link>
    </Button>
  );
}

/** 标题下面那一行（Page 把说明放在 <p> 里，这里只能用行内元素）。 */
function Header({ d, now }: { d: TaskDetail; now: number }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <StatusChip tone={taskTone(d.task)} label={taskStateLabel[d.task.state]} />
      <RepoLink
        repo={d.repo}
        kind="issues"
        n={d.task.issueNumber}
        className="num underline-offset-2 hover:underline"
      >
        {d.repo.owner}/{d.repo.name}#{d.task.issueNumber}
      </RepoLink>
      <span className="num">开单 {formatAgo(d.task.createdAt, now)}</span>
    </span>
  );
}

/** 老流程（会话 session_runs）的那几块：会话时间线、时间与用量。 */
function SessionPart({ d, now, mixed }: { d: TaskDetail; now: number; mixed: boolean }) {
  const { data: routing } = useRouting();
  if (mixed) {
    return (
      <Panel
        title="老流程的会话"
        description="三段之前按老流程跑的会话；上面的合计和按模型已经把它们算进去了。"
        className="mt-4"
      >
        <RunTimeline runs={d.runs} routing={routing} now={now} />
      </Panel>
    );
  }
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-3">
      <Panel title="会话时间线" description="斜纹是排队，实色是干活。" className="lg:col-span-2">
        <RunTimeline runs={d.runs} routing={routing} now={now} />
      </Panel>
      <UsagePanel d={d} now={now} />
    </div>
  );
}

/** 「用哪个模型」：演示版没有路由页、改不了，不画；结束了的单从没指定过，也没什么可看的，不画。 */
function Pins({ d, now }: { d: TaskDetail; now: number }) {
  if (isDemo()) return null;
  if (isTaskFinished(d.task) && !d.routePins.pins.length && !d.routePins.unavailable) return null;
  return <TaskModelPins d={d} now={now} />;
}

function Body({ d, now }: { d: TaskDetail; now: number }) {
  if (!d.segmentRuns.length && !d.runs.length) {
    return (
      <>
        <Panel>
          <Empty
            icon={ListChecks}
            title="这张单还没跑过"
            hint="三段（对题、动手、验收）跑起来以后，每一笔都记在这里。"
          />
        </Panel>
        <Pins d={d} now={now} />
      </>
    );
  }
  if (!d.segmentRuns.length) {
    return (
      <>
        <SessionPart d={d} now={now} mixed={false} />
        <Pins d={d} now={now} />
      </>
    );
  }
  return (
    <>
      <SegmentStats d={d} now={now} />
      <Pins d={d} now={now} />
      <div className="mt-4 space-y-4">
        <SegmentBreakdown d={d} now={now} />
        <SegmentRunList d={d} now={now} />
      </div>
      {d.runs.length ? <SessionPart d={d} now={now} mixed /> : null}
    </>
  );
}

export default function TaskPage() {
  const { taskId } = useParams();
  const detail = useTaskDetail(taskId);
  const now = useNow();
  if (!canSee('task')) return <NotOpen />;
  const d = detail.data;
  return (
    <Page
      title={
        d ? (
          <>
            <span className="num text-muted-foreground">#{d.task.issueNumber}</span> {d.task.title}
          </>
        ) : (
          '任务'
        )
      }
      description={d ? <Header d={d} now={now} /> : undefined}
      actions={<Back />}
    >
      {detail.error ? (
        <LoadError what="这张单" error={detail.error} />
      ) : !d ? (
        <LoadingRows rows={6} />
      ) : (
        <Body d={d} now={now} />
      )}
    </Page>
  );
}
