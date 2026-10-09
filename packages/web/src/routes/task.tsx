// 任务页（/tasks/:taskId）：一张单走了哪几段、每段每个模型花了多久、多少 token 和钱（#216）；动手、验收各用哪个模型，
// 能在这里指定或回到自动（驾驶舱改版 2026-10-07，components/task-model-pins.tsx）。执行体没报花费的按目录单价估、标「估算」。
// 主页「在跑的」卡片、「要你拍的」都链到这里。三段的单读 runs 表的流水（segmentRuns、usage.bySegment）；
// 老流程的单照旧是会话时间线加「时间与用量」。读不到的写「没读到」和原因，不写 0。

import { ArrowLeft, ListChecks, SearchX } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { brand } from '#brand';
import { isNotFound, useRouting, useTaskDetail } from '../api/client';
import type { TaskDetail } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RepoLink } from '../components/repo-link';
import { RunTimeline } from '../components/run-timeline';
import { SegmentBreakdown, SegmentRunList, SegmentStats } from '../components/segment-usage';
import { StatusChip } from '../components/status';
import { ActionButtons } from '../components/task-actions';
import { TaskModelPins } from '../components/task-model-pins';
import { Button } from '../components/ui/button';
import { UsagePanel } from '../components/usage';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useShownError } from '../lib/shown-error';
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
      {d.task.paused === undefined ? (
        <StatusChip tone={taskTone(d.task)} label={taskStateLabel[d.task.state]} />
      ) : (
        // 暂停的单 state 仍是「在干活」，但人让它停了：等待色（黄系），不画成失败红（#820 片 3）
        <StatusChip tone="stall" label="已暂停" />
      )}
      {d.task.paused === undefined ? null : <span data-paused-note>{d.task.paused}</span>}
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

/**
 * 暂停、继续、叫停、重做（#820 片 3 已接到这一页，#856 第 1 处核对后仍用这一份 ActionButtons）。
 * 点了发 POST /api/tasks/:taskId/actions。做完、失败的不画。已叫停的只画「重做」。
 */
function TaskActionBar({ d }: { d: TaskDetail }) {
  return (
    <ActionButtons
      target={{
        taskId: d.task.id,
        issueNumber: d.task.issueNumber,
        title: d.task.title,
        state: d.task.state,
        paused: d.task.paused,
      }}
    />
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

/** 「用哪个模型」：结束了的单从没指定过，也没什么可看的，不画。 */
function Pins({ d, now }: { d: TaskDetail; now: number }) {
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

const GITHUB_ISSUE_HINT =
  '这看起来是 GitHub 单号。任务页地址要用任务编号（例如 t-12），到主页的在跑列表里点进去';

/** 地址参数一个数字都不夹别的字：人多半把 GitHub 单号填进了任务页。 */
function looksLikeIssueNumber(taskId: string | undefined): boolean {
  return taskId !== undefined && /^[0-9]+$/.test(taskId);
}

/** 没有这张单（后端 404）：写明，给回主页的路；不转圈、不给「重试」（重试也不会有）。纯数字再补一句单号和任务编号的区别。 */
function Missing({ taskId }: { taskId: string | undefined }) {
  return (
    <Panel>
      <div role="alert">
        <Empty
          icon={SearchX}
          title="没有这张单"
          hint={
            <>
              <span className="block">
                库里没有编号为「<span className="num">{taskId ?? ''}</span>
                」的单：可能链接里的编号写错了，或这张单已经不在了。
              </span>
              {looksLikeIssueNumber(taskId) ? <span className="mt-2 block">{GITHUB_ISSUE_HINT}</span> : null}
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to="/">回主页</Link>
              </Button>
            </>
          }
        />
      </div>
    </Panel>
  );
}

export default function TaskPage() {
  const { taskId } = useParams();
  const detail = useTaskDetail(taskId);
  // 推送重读会把从没读成过的查询退回骨架：显示记住的那次失败（lib/shown-error.ts）
  const error = useShownError(taskId, detail);
  const now = useNow();
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
      actions={
        <>
          {d ? <TaskActionBar d={d} /> : null}
          <Back />
        </>
      }
    >
      {error && isNotFound(error) ? (
        <Missing taskId={taskId} />
      ) : error ? (
        <LoadError what="这张单" error={error} onRetry={() => void detail.refetch()} />
      ) : !d ? (
        <LoadingRows rows={6} />
      ) : (
        <Body d={d} now={now} />
      )}
    </Page>
  );
}
