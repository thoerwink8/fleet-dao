// 任务页（/tasks/:taskId）：一张单走了哪几段、每段每个模型花了多久、多少 token 和钱（#216）；动手、验收各用哪个模型，
// 能在这里指定或回到自动（components/task-model-pins.tsx）。执行体没报花费的按目录单价估、标「估算」。
// 主页「在跑的」卡片、「要你拍的」都链到这里。三段的单读 runs 表的流水（segmentRuns、usage.bySegment）；
// 老流程的单照旧是会话时间线加「时间与用量」。读不到的写「没读到」和原因，不写 0。
//
// 层级照路由页样板（#1914，本页 #1920）：标题下先是一句结论块（这张单现在怎么样 + 一个状态，下面一行灰字：仓#单号、开单、PR），
// 再是四个数，然后才是明细（用哪个模型、三段、每一笔、老流程的会话）。各块的长说明收进页头 ⓘ，块头只留一句。

import { errMessage } from '@fleet-dao/shared/util';
import { ListChecks, SearchX } from 'lucide-react';
import { Fragment, type ReactNode, useRef } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { isNotFound, useRouting, useTaskDetail } from '../api/client';
import type { TaskDetail } from '../api/types';
import { EmptyState } from '../components/layout/empty-state';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { StatusBadge } from '../components/layout/status-badge';
import type { LayoutTone } from '../components/layout/tone';
import { RepoLink } from '../components/repo-link';
import { RunTimeline } from '../components/run-timeline';
import { RunTranscriptDrawer } from '../components/run-transcript';
import { SegmentBreakdown, SegmentRunList, SegmentStats } from '../components/segment-usage';
import { ActionButtons } from '../components/task-actions';
import { TaskModelPins } from '../components/task-model-pins';
import { Button } from '../components/ui/button';
import { UsagePanel } from '../components/usage';
import { stageLabel } from '../lib/catalog';
import { formatAgo, formatDuration, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { liveMs, runNth, segmentLabel, UNKNOWN_SEGMENT } from '../lib/segments';
import { useShownError } from '../lib/shown-error';
import { isTaskFinished, taskStateLabel, taskTone, workMs } from '../lib/status';
import { backToList, FROM_PARAM } from '../lib/task-list';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('任务') }];
}

/** 页头 ⓘ：各块是什么、怎么读（原来摊在每一块的块头，一块两三行）。 */
const DETAIL = (
  <div className="space-y-2">
    <p>一张单走了哪几段、每段每个模型花了多久、多少 token 和钱；读不到的写明没读到，不当成 0。</p>
    <ul className="list-disc space-y-1 pl-4">
      <li>顶上一句是这张单现在怎么样；灰字行是仓和单号（点开去 GitHub）、开单时间、最新的 PR。</li>
      <li>
        用哪个模型：给动手、验收指定模型，下一次选路起照它，在跑的这一轮不打断；动手这一轮想当场换，点「现在就换」。
        指定的派不出时引擎停下等你，不悄悄换别的。
      </li>
      <li>三段：对题 → 动手 → 验收，每段再按模型分。没读到的格子留 —，不是 0；段名悬停看这一段做什么。</li>
      <li>
        每一笔：三段每跑一次一笔，按起跑先后。没记 task_id、按单号对上的标「按单号兜底」；没读到的写明为什么。
        点「看会话」在右侧抽屉里看会话内容，网址带着这一笔，能发给别人。
      </li>
      <li>老流程的会话时间线：斜纹是排队，实色是干活。</li>
    </ul>
  </div>
);

/** 从任务列表点进来的（链接带 ?from=/tasks?…）回列表并带回筛选；别处进来的照旧回主页。 */
function Crumbs({ d }: { d: TaskDetail | undefined }) {
  const [params] = useSearchParams();
  const list = backToList(params.get(FROM_PARAM));
  return (
    <ol className="flex flex-wrap items-center gap-1" data-breadcrumb>
      <li>
        <Link
          to={list ?? '/'}
          aria-label={list ? '回任务列表' : '回主页'}
          className="inline-flex underline-offset-2 hover:text-foreground hover:underline max-md:min-h-10 max-md:items-center"
        >
          {list ? '任务列表' : '主页'}
        </Link>
      </li>
      <li aria-hidden>/</li>
      <li aria-current="page" className="num">
        {d ? `#${d.task.issueNumber}` : '任务'}
      </li>
    </ol>
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
        ...(d.task.stalled === undefined ? {} : { parkedWhy: d.task.stalled.why }),
      }}
    />
  );
}

/** 老流程（会话 session_runs）的那几块：会话时间线、时间与用量。 */
function SessionPart({ d, now, mixed }: { d: TaskDetail; now: number; mixed: boolean }) {
  const { data: routing } = useRouting();
  if (mixed) {
    return (
      <Section title="老流程的会话" description="三段之前按老流程跑的会话，上面的合计已经算进去了">
        <RunTimeline runs={d.runs} routing={routing} now={now} />
      </Section>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Section title="会话时间线" description="斜纹是排队，实色是干活" className="lg:col-span-2">
        <RunTimeline runs={d.runs} routing={routing} now={now} />
      </Section>
      <UsagePanel d={d} now={now} />
    </div>
  );
}

/** 「用哪个模型」：结束了的单从没指定过，也没什么可看的，不画。 */
function Pins({ d, now }: { d: TaskDetail; now: number }) {
  if (isTaskFinished(d.task) && !d.routePins.pins.length && !d.routePins.unavailable) return null;
  return <TaskModelPins d={d} now={now} />;
}

/** 最新的 PR：段流水里最后一个带 PR 的，没有再看子任务。 */
function latestPr(d: TaskDetail): number | undefined {
  return (
    [...d.segmentRuns]
      .map((r) => r.prNumber)
      .filter((n): n is number => n !== undefined)
      .at(-1) ??
    d.subtasks
      .map((s) => s.prNumber)
      .filter((n): n is number => n !== undefined)
      .at(-1)
  );
}

/**
 * 结论那一句：这张单现在怎么样（状态标签已经写了的不再重复）。只写短话，放不下截断，整句在悬停里。
 * 只读详情里已有的段流水，不另要后端字段。
 */
export function taskConclusion(
  d: TaskDetail,
  now: number,
): { tone: LayoutTone; label: string; text: string } {
  const paused = d.task.paused;
  const tone: LayoutTone = paused === undefined ? taskTone(d.task) : 'stall';
  const label = paused === undefined ? taskStateLabel[d.task.state] : '已暂停';
  const runs = d.segmentRuns;
  const segOf = (s: (typeof runs)[number] | undefined) =>
    s?.segment ? segmentLabel[s.segment] : UNKNOWN_SEGMENT;
  const running = [...runs].filter((r) => r.running).at(-1);
  const last = runs.at(-1);
  if (paused !== undefined) return { tone, label, text: paused };
  if (running) {
    const live = liveMs(running, now);
    const parts = [running.modelName, live === undefined ? '' : `已跑 ${formatDuration(live)}`].filter(
      Boolean,
    );
    return { tone, label, text: `${segOf(running)}中：${parts.join('，')}` };
  }
  // 老流程的会话还在跑（三段之前的单、两种流水都有的单）：照样写哪一步、哪个模型、干了多久
  const liveSession = [...d.runs].filter((r) => !r.endedAt && r.startedAt).at(-1);
  if (liveSession) {
    return {
      tone,
      label,
      text: `${stageLabel[liveSession.stage]}中：${liveSession.modelName}，已跑 ${formatDuration(workMs(liveSession, now))}`,
    };
  }
  const segments = new Set(runs.map((r) => r.segment)).size;
  switch (d.task.state) {
    case 'done':
      return {
        tone,
        label,
        text: runs.length ? `做完了，${segments} 段共跑了 ${runs.length} 笔` : '做完了',
      };
    case 'failed':
      return {
        tone,
        label,
        text: last?.failureReason
          ? `${segOf(last)}没成：${last.failureReason}`
          : last
            ? `停在${segOf(last)}`
            : '没跑起来',
      };
    case 'stopped':
      return { tone, label, text: last ? `被叫停，停在${segOf(last)}` : '被叫停，还没跑过' };
    case 'stalled':
      return { tone, label, text: last ? `${segOf(last)}之后没动静` : '一直没动静' };
    case 'queued':
      return { tone, label, text: '还没开跑，等空位' };
    default:
      return { tone, label, text: last ? `等下一段开跑，上一段是${segOf(last)}` : '还没开跑' };
  }
}

/**
 * 首屏结论块（照路由页样板的标题块；#1751 起首屏先给状态、已跑多久、PR 号）：
 * 第一行结论短话加一个状态；第二行灰字：仓#单号（去 GitHub）、开单多久、最新的 PR、暂停的原因。两行都不折。
 */
function TaskHero({ d, now }: { d: TaskDetail; now: number }) {
  const c = taskConclusion(d, now);
  const pr = latestPr(d);
  // 手机上灰字行里的链接要 40 高好点；桌面照常
  const link =
    'num underline-offset-2 hover:underline max-md:inline-flex max-md:min-h-10 max-md:items-center';
  const meta: { key: string; node: ReactNode }[] = [
    {
      key: 'repo',
      node: (
        <RepoLink repo={d.repo} kind="issues" n={d.task.issueNumber} className={link}>
          {d.repo.owner}/{d.repo.name}#{d.task.issueNumber}
        </RepoLink>
      ),
    },
    { key: 'opened', node: <span className="num">开单 {formatAgo(d.task.createdAt, now)}</span> },
    ...(pr === undefined
      ? []
      : [
          {
            key: 'pr',
            node: (
              <RepoLink repo={d.repo} kind="pull" n={pr} className={link}>
                PR #{pr}
              </RepoLink>
            ),
          },
        ]),
  ];
  return (
    <header data-now-banner className="mb-6 flex min-w-0 flex-col max-md:mb-4">
      <p
        data-hero-line
        title={c.text}
        className="flex min-w-0 items-center gap-2.5 whitespace-nowrap text-heading font-normal"
      >
        <span data-hero-text className="min-w-0 truncate">
          {d.task.paused === undefined ? c.text : <span data-paused-note>{c.text}</span>}
        </span>
        <span className="shrink-0">
          <StatusBadge tone={c.tone} label={c.label} />
        </span>
      </p>
      <p
        data-hero-notes
        className="mt-1.5 flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-meta text-muted-foreground"
      >
        {meta.map((m, i) => (
          <Fragment key={m.key}>
            {i > 0 ? (
              <span aria-hidden className="shrink-0">
                ·
              </span>
            ) : null}
            <span className={cn('min-w-0', i === 0 ? 'truncate' : 'shrink-0')}>{m.node}</span>
          </Fragment>
        ))}
      </p>
    </header>
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

/** 结论块下面的明细：一块接一块，块间距一样（区块间距令牌，经 Section 自己的外边距）。 */
function Body({ d, now }: { d: TaskDetail; now: number }) {
  if (!d.segmentRuns.length && !d.runs.length) {
    return (
      <>
        <TaskHero d={d} now={now} />
        <div className="flex flex-col gap-4 lg:gap-6">
          <Section>
            <EmptyState
              icon={ListChecks}
              title="这张单还没跑过"
              hint="三段（对题、动手、验收）跑起来以后，每一笔都记在这里。"
            />
          </Section>
          <Pins d={d} now={now} />
        </div>
      </>
    );
  }
  if (!d.segmentRuns.length) {
    return (
      <>
        <TaskHero d={d} now={now} />
        <div className="flex flex-col gap-4 lg:gap-6">
          <SessionPart d={d} now={now} mixed={false} />
          <Pins d={d} now={now} />
        </div>
      </>
    );
  }
  return (
    <>
      <TaskHero d={d} now={now} />
      <div className="flex flex-col gap-4 lg:gap-6">
        <SegmentStats d={d} now={now} />
        <Pins d={d} now={now} />
        <SegmentBreakdown d={d} now={now} />
        <RunsWithDrawer d={d} now={now} />
        {d.runs.length ? <SessionPart d={d} now={now} mixed /> : null}
      </div>
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
    <Section>
      <div role="alert">
        <EmptyState
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
    </Section>
  );
}

/** 任务详情靠推送更新，没有自己的轮询。这份快照超过 5 分钟还没再读成，刷新钮旁标「数据已过期」。 */
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
      detail={d ? DETAIL : undefined}
      refresh={{
        onRefresh: () => void detail.refetch(),
        isFetching: detail.isFetching,
        dataUpdatedAt: detail.dataUpdatedAt,
        staleAfterMs: TASK_STALE_AFTER_MS,
      }}
      breadcrumb={<Crumbs d={d} />}
      actions={d ? <TaskActionBar d={d} /> : undefined}
    >
      {error && isNotFound(error) ? (
        <Missing taskId={taskId} />
      ) : error && !d ? (
        <LoadError what="这张单" error={error} onRetry={() => void detail.refetch()} />
      ) : !d ? (
        <LoadingRows rows={6} />
      ) : (
        <>
          {/* 读成过、这次刷新没读成：照旧画上一次读到的，顶上一条横幅带重试（不把看得到的清空） */}
          {error ? (
            <div className="mb-4">
              <LoadError
                text={`这张单刷新没读成，下面是上一次读到的：${errMessage(error)}`}
                error={error}
                onRetry={() => void detail.refetch()}
              />
            </div>
          ) : null}
          <Body d={d} now={now} />
        </>
      )}
    </Page>
  );
}
