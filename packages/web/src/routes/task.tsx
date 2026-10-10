// 任务页（/tasks/:taskId）：一张单走了哪几段、每段每个模型花了多久、多少 token 和钱（#216）；动手、验收各用哪个模型，
// 能在这里指定或回到自动（驾驶舱改版 2026-10-07，components/task-model-pins.tsx）。执行体没报花费的按目录单价估、标「估算」。
// 主页「在跑的」卡片、「要你拍的」都链到这里。三段的单读 runs 表的流水（segmentRuns、usage.bySegment）；
// 老流程的单照旧是会话时间线加「时间与用量」。读不到的写「没读到」和原因，不写 0。

import { ArrowLeft, ListChecks, SearchX } from 'lucide-react';
import { useRef } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { isNotFound, useRouting, useTaskDetail } from '../api/client';
import type { TaskDetail } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { RepoLink } from '../components/repo-link';
import { RunTimeline } from '../components/run-timeline';
import { RunTranscriptDrawer } from '../components/run-transcript';
import { SegmentBreakdown, SegmentRunList, SegmentStats } from '../components/segment-usage';
import { StatusChip } from '../components/status';
import { ActionButtons } from '../components/task-actions';
import { TaskModelPins } from '../components/task-model-pins';
import { Button } from '../components/ui/button';
import { UsagePanel } from '../components/usage';
import { formatAgo, formatDuration, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { liveMs, runNth, segmentLabel } from '../lib/segments';
import { useShownError } from '../lib/shown-error';
import { isTaskFinished, taskStateLabel, taskTone } from '../lib/status';
import { backToList, FROM_PARAM } from '../lib/task-list';

export function meta() {
  return [{ title: brand.title('任务') }];
}

/** 从任务列表点进来的（链接带 ?from=/tasks?…）回列表并带回筛选；别处进来的照旧回主页。 */
function Back() {
  const [params] = useSearchParams();
  const list = backToList(params.get(FROM_PARAM));
  return (
    <Button asChild size="sm" variant="ghost" className="h-7">
      <Link to={list ?? '/'}>
        <ArrowLeft className="size-3.5" aria-hidden />
        {list ? '回任务列表' : '回主页'}
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

/**
 * 首屏当前这一轮在做什么（#1751）：状态、已跑多久、PR 号放最上，花费类大格往下挪。
 * 只读详情里已有的段流水 / 子任务，不另要后端字段。
 */
function NowBanner({ d, now }: { d: TaskDetail; now: number }) {
  const paused = d.task.paused !== undefined;
  const running = [...d.segmentRuns].filter((r) => r.running).at(-1);
  const live = running ? liveMs(running, now) : undefined;
  const prNumber =
    [...d.segmentRuns]
      .map((r) => r.prNumber)
      .filter((n): n is number => n !== undefined)
      .at(-1) ??
    d.subtasks
      .map((s) => s.prNumber)
      .filter((n): n is number => n !== undefined)
      .at(-1);
  return (
    <div
      data-now-banner
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-card px-4 py-3 shadow-card-edge"
    >
      {paused ? (
        <StatusChip tone="stall" label="已暂停" />
      ) : (
        <StatusChip tone={taskTone(d.task)} label={taskStateLabel[d.task.state]} />
      )}
      {running?.segment ? <span className="text-sm font-medium">{segmentLabel[running.segment]}</span> : null}
      {running?.modelName ? (
        <span className="num text-sub text-muted-foreground">{running.modelName}</span>
      ) : null}
      {live !== undefined ? <span className="num text-sm">已跑 {formatDuration(live)}</span> : null}
      {prNumber !== undefined ? (
        <RepoLink
          repo={d.repo}
          kind="pull"
          n={prNumber}
          className="num text-sm underline-offset-2 hover:underline"
        >
          PR #{prNumber}
        </RepoLink>
      ) : null}
    </div>
  );
}

/** 网址里开着哪一笔的会话抽屉。 */
export const RUN_PARAM = 'run';

/**
 * 「每一笔」加右侧的会话抽屉（#1802）：点「看会话」把 ?run=<笔号> 推进网址（保留别的参数），抽屉开；网址可分享，
 * 浏览器后退就关。直接打开带 ?run= 的链接，关的时候不后退（后退会离开本页），只把参数去掉。网址里的笔号对不上这张单的任何一笔就不开。
 */
function RunsWithDrawer({ d, now }: { d: TaskDetail; now: number }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const pushed = useRef(false);
  const runId = params.get(RUN_PARAM);
  const active = runId ? d.segmentRuns.find((r) => r.id === runId) : undefined;
  const open = (id: string) => {
    pushed.current = true;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(RUN_PARAM, id);
      return next;
    });
  };
  const close = () => {
    if (pushed.current) {
      pushed.current = false;
      void navigate(-1);
      return;
    }
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(RUN_PARAM);
        return next;
      },
      { replace: true },
    );
  };
  return (
    <>
      <SegmentRunList d={d} now={now} onViewTranscript={open} />
      {active ? (
        <RunTranscriptDrawer
          key={active.id}
          taskId={d.task.id}
          run={active}
          nth={runNth(d.segmentRuns, active.id) ?? 1}
          now={now}
          onClose={close}
        />
      ) : null}
    </>
  );
}

function Body({ d, now }: { d: TaskDetail; now: number }) {
  if (!d.segmentRuns.length && !d.runs.length) {
    return (
      <>
        <NowBanner d={d} now={now} />
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
        <NowBanner d={d} now={now} />
        <SessionPart d={d} now={now} mixed={false} />
        <Pins d={d} now={now} />
      </>
    );
  }
  return (
    <>
      <NowBanner d={d} now={now} />
      <SegmentStats d={d} now={now} />
      <Pins d={d} now={now} />
      <div className="mt-4 space-y-4">
        <SegmentBreakdown d={d} now={now} />
        <RunsWithDrawer d={d} now={now} />
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

/** 任务详情靠推送更新，没有自己的轮询。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const TASK_STALE_AFTER_MS = 5 * TIME.MIN;

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
          <RefreshBar
            onRefresh={() => void detail.refetch()}
            isFetching={detail.isFetching}
            dataUpdatedAt={detail.dataUpdatedAt}
            staleAfterMs={TASK_STALE_AFTER_MS}
          />
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
