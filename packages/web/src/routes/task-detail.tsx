import {
  ArrowLeft,
  Check,
  ChevronRight,
  Circle,
  ExternalLink,
  FileCode2,
  FileText,
  GitPullRequest,
  MessageCircleQuestion,
} from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { brand } from '#brand';
import {
  errorText,
  useBoard,
  useMe,
  useRouting,
  useRunSteps,
  useTaskDetail,
  useTimeline,
} from '../api/client';
import type { Ask, BoardSubtask, BoardTask, Routing, Run, TaskDetail, TimelineItem } from '../api/types';
import { LogStream } from '../components/log-stream';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RepoLink, repoHref } from '../components/repo-link';
import { RunTimeline } from '../components/run-timeline';
import { StatusChip, StatusDot, ToneBar } from '../components/status';
import { ActionButtons, targetOf, useTaskActions } from '../components/task-actions';
import { Button } from '../components/ui/button';
import { canSeeDetail } from '../demo/access';
import { HiddenNote } from '../demo/views';
import { stageLabel } from '../lib/catalog';
import { formatAgo, formatCount, formatDuration, formatUsd, span } from '../lib/format';
import { useNow } from '../lib/hooks';
import { taskPhases } from '../lib/phases';
import {
  describeSubtask,
  describeTask,
  isMine,
  isRunning,
  isTaskFinished,
  latestRun,
  letterOf,
  queueMs,
  subtaskStateLabel,
  subtaskTone,
  taskStateLabel,
  taskTone,
  toneBg,
  toneText,
  workMs,
} from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('任务详情') }];
}

/** 「需求级」那一栏的编号（分诊、需求文档、方案这些不属于子任务的会话）。 */
const FRONT = 'front';

/**
 * 详情接口没有「此刻在干什么」，看板上有。看板里找得到就用看板那份（后端拼好的白话），
 * 找不到（换了仓、还没加载）就按会话自己拼一份，只用来画阶段条。
 */
function boardTaskOf(d: TaskDetail, fromBoard: BoardTask | undefined): BoardTask {
  if (fromBoard) return fromBoard;
  const run = latestRun(d.runs, undefined);
  const active = run && !run.endedAt ? run : undefined;
  const merged = d.subtasks.filter((s) => s.state === 'merged').length;
  const t: BoardTask = {
    id: d.task.id,
    issueNumber: d.task.issueNumber,
    title: d.task.title,
    state: d.task.state,
    priority: d.task.priority,
    requestedBy: d.task.requestedBy,
    createdAt: d.task.createdAt,
    progress: { done: merged, total: d.subtasks.length },
    subtasks: d.subtasks,
  };
  if (active) {
    t.activity = {
      runId: active.id,
      stage: active.stage,
      routeId: active.routeId,
      modelName: active.modelName,
      queued: !active.startedAt,
      since: active.startedAt ?? active.queuedAt,
      text: `${active.modelName} ${active.startedAt ? `在${stageLabel[active.stage]}` : '排队中'}`,
    };
  }
  return t;
}

export default function TaskDetailPage() {
  const { taskId } = useParams();
  const detail = useTaskDetail(taskId);
  const board = useBoard(detail.data?.repo.id);
  const timeline = useTimeline(taskId);
  const { data: routing } = useRouting();
  const { data: me } = useMe();
  const now = useNow();
  const [params, setParams] = useSearchParams();

  if (detail.error) {
    return (
      <Page title="任务详情">
        <LoadError error={detail.error} />
      </Page>
    );
  }
  if (detail.isLoading) {
    return (
      <Page title="任务详情">
        <LoadingRows rows={6} />
      </Page>
    );
  }
  const d = detail.data;
  if (!d) {
    return (
      <Page title="任务详情">
        <Empty icon={FileText} title="没有这个需求" hint="可能是编号写错了，回任务清单看看。" />
      </Page>
    );
  }

  const t = boardTaskOf(
    d,
    board.data?.tasks.find((x) => x.id === d.task.id),
  );
  const subs = [...d.subtasks].sort((a, b) => a.index - b.index);
  const wanted = params.get('sub');
  const tab =
    wanted === FRONT || subs.some((s) => s.id === wanted)
      ? (wanted as string)
      : (subs.find((s) => s.activity)?.id ?? subs[0]?.id ?? FRONT);
  const selected = subs.find((s) => s.id === tab);
  const tone = taskTone(t);
  const items = timeline.data?.pages.flatMap((p) => p.items) ?? [];
  const pendingAsks = d.asks.filter((a) => a.status === 'pending');
  const answeredAsks = d.asks.filter((a) => a.status === 'answered');
  const issueUrl = repoHref(d.repo, 'issues', d.task.issueNumber);

  const selectTab = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('sub', id);
    setParams(p, { replace: true });
  };

  const logProps = {
    hasMore: Boolean(timeline.hasNextPage),
    onMore: () => void timeline.fetchNextPage(),
    loadingMore: timeline.isFetchingNextPage,
    error: timeline.error ?? undefined,
  };

  return (
    <Page
      title={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link to="/tasks" className="text-muted-foreground hover:text-foreground" aria-label="回任务清单">
            <ArrowLeft className="size-5" />
          </Link>
          <span className="num text-muted-foreground">#{d.task.issueNumber}</span>
          <span>{d.task.title}</span>
          <StatusChip tone={tone} label={taskStateLabel[t.state]} className="h-6 text-xs" />
        </span>
      }
      description={<span className={cn(tone !== 'run' && toneText[tone])}>{describeTask(t, now)}</span>}
      actions={<ActionButtons target={targetOf(t)} />}
    >
      <div className="-mt-3 mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          仓 <span className="num text-foreground">{`${d.repo.owner}/${d.repo.name}`}</span>
        </span>
        <span>
          提出人{' '}
          <span className="text-foreground">
            {isMine(d.task.requestedBy, me) ? '我' : d.task.requestedBy}
          </span>
        </span>
        <span>
          开单 <span className="num text-foreground">{formatAgo(d.task.createdAt, now)}</span>
        </span>
        <span>
          优先级 <span className="num text-foreground">P{d.task.priority}</span>
        </span>
        {issueUrl ? (
          <a
            href={issueUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            GitHub issue <ExternalLink className="size-3" />
          </a>
        ) : null}
        {d.task.specDir ? (
          <span className="inline-flex items-center gap-1">
            <FileText className="size-3" />
            需求文档 <span className="num text-foreground">{d.task.specDir}</span>
          </span>
        ) : null}
      </div>

      {pendingAsks.map((a) => (
        <AskCard key={a.id} ask={a} t={t} now={now} />
      ))}

      <Phases t={t} now={now} />

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <div
            className="flex gap-1 overflow-x-auto rounded-xl border bg-card p-1"
            role="tablist"
            aria-label="子任务"
          >
            <TabButton active={tab === FRONT} onClick={() => selectTab(FRONT)}>
              <span className="text-muted-foreground">需求级</span>
              <span className="text-xs text-faint">分诊 · 需求 · 方案</span>
            </TabButton>
            {subs.map((s) => {
              const st = subtaskTone(s);
              return (
                <TabButton key={s.id} active={s.id === tab} onClick={() => selectTab(s.id)}>
                  <span className={cn('num font-bold', toneText[st])}>{letterOf(s.index)}</span>
                  <span className="max-w-44 truncate">{s.title}</span>
                  <StatusDot tone={st} />
                </TabButton>
              );
            })}
          </div>

          {selected ? (
            <SubtaskSection
              d={d}
              t={t}
              s={selected}
              subs={subs}
              routing={routing}
              items={items}
              now={now}
              {...logProps}
            />
          ) : (
            <FrontSection d={d} routing={routing} items={items} now={now} {...logProps} />
          )}
        </div>

        <div className="space-y-4">
          <Panel title="原话">
            {canSeeDetail('process') ? (
              <blockquote className="rounded-lg border-l-2 border-border-strong bg-muted/60 px-3 py-2 text-sm whitespace-pre-wrap">
                {d.task.rawRequest}
              </blockquote>
            ) : (
              <HiddenNote what="需求的原话" />
            )}
          </Panel>
          {answeredAsks.length && canSeeDetail('process') ? (
            <Panel title="问答记录" description="AI 问过你的、你怎么答的。">
              <ul className="space-y-3">
                {answeredAsks.map((a) => (
                  <li key={a.id} className="text-sm">
                    <div className="flex gap-1.5">
                      <MessageCircleQuestion
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span>{a.question}</span>
                    </div>
                    <div className="mt-1 ml-5.5 rounded-md bg-muted/60 px-2 py-1">
                      {a.answer}
                      <span className="num ml-1 text-xs text-muted-foreground">
                        {a.answeredBy ? `· ${isMine(a.answeredBy, me) ? '我' : a.answeredBy} ` : ''}
                        {a.answeredAt ? `· ${formatAgo(a.answeredAt, now)}` : ''}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          <Usage d={d} now={now} />
        </div>
      </div>
    </Page>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
        active ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function Usage({ d, now }: { d: TaskDetail; now: number }) {
  const runs = d.runs;
  const queueTotal = runs.reduce((n, r) => n + queueMs(r, now), 0);
  const workTotal = runs.reduce((n, r) => n + workMs(r, now), 0);
  const tokens = runs.reduce((n, r) => n + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0);
  const cost = runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  // 做完的需求算到最后一个会话结束；契约里没有「做完的时刻」。
  const lastEnd = runs.reduce<string | undefined>(
    (m, r) => (r.endedAt && (!m || r.endedAt > m) ? r.endedAt : m),
    undefined,
  );
  const total = span(d.task.createdAt, isTaskFinished(d.task) ? lastEnd : undefined, now);
  return (
    <Panel title="时间与用量" description="排队和干活分开算。">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Fact label={isTaskFinished(d.task) ? '总耗时' : '已用时'} value={formatDuration(total)} />
        <Fact label="会话" value={`${runs.length} 个`} />
        <Fact label="排队合计" value={formatDuration(queueTotal)} />
        <Fact label="干活合计" value={formatDuration(workTotal)} />
        <Fact label="token" value={tokens ? formatCount(tokens) : '—'} />
        <Fact label="按量花费" value={cost ? formatUsd(cost) : '没有按量花费'} />
      </dl>
    </Panel>
  );
}

function AskCard({ ask, t, now }: { ask: Ask; t: BoardTask; now: number }) {
  const { trigger } = useTaskActions();
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-xl border border-st-human/50 bg-st-human/[0.07] p-4 md:flex-row md:items-center">
      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-st-human/15 text-ink-human">
        <MessageCircleQuestion className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">
          AI 在问你{' '}
          <span className="num ml-1 text-xs font-normal text-muted-foreground">
            {formatAgo(ask.askedAt, now)}
          </span>
        </div>
        <div className="mt-0.5 text-sm">{ask.question}</div>
        {ask.options.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ask.options.map((o) => (
              <span key={o} className="rounded-full border bg-card px-2 py-0.5 text-xs">
                {o}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <Button onClick={() => trigger('answer', targetOf(t))} disabled={isTaskFinished(t)}>
        回答
      </Button>
    </div>
  );
}

function Phases({ t, now }: { t: BoardTask; now: number }) {
  const phases = taskPhases(t, now);
  return (
    <ol className="grid grid-cols-5 gap-1.5 rounded-xl border bg-card p-3" aria-label="阶段">
      {phases.map((p, i) => (
        <li key={p.key} className="min-w-0">
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                'h-1.5 flex-1 rounded-full',
                p.state === 'pending' ? 'bg-foreground/10' : toneBg[p.tone],
                p.state === 'done' && 'opacity-70',
                p.state === 'active' && p.tone === 'run' && 'fd-sweep',
              )}
            />
            {i < phases.length - 1 ? (
              <ChevronRight className="size-3 shrink-0 text-faint" aria-hidden />
            ) : null}
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className={cn('text-sm font-medium', p.state === 'pending' && 'text-faint')}>
              {p.label}
            </span>
            {p.ms ? (
              <span className="num text-[11px] text-muted-foreground">{formatDuration(p.ms)}</span>
            ) : null}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {p.modelName ? (
              <span className="num">{p.modelName}</span>
            ) : (
              (p.detail ?? (p.state === 'pending' ? '还没到' : p.state === 'done' ? '完成' : ''))
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

interface LogPaging {
  hasMore: boolean;
  onMore(): void;
  loadingMore: boolean;
  error: unknown;
}

/** 需求级：分诊、需求文档、方案这些不属于子任务的会话和日志。 */
function FrontSection({
  d,
  routing,
  items,
  now,
  ...paging
}: { d: TaskDetail; routing: Routing | undefined; items: TimelineItem[]; now: number } & LogPaging) {
  const runs = d.runs.filter((r) => !r.subtaskId);
  const runIds = new Set(runs.map((r) => r.id));
  const own = items.filter((e) => !e.subtaskId && (!e.runId || runIds.has(e.runId)));
  return (
    <>
      <Panel title="会话时间线" description="斜纹是排队，实色是干活；每一条都写着为什么派给它。">
        <RunTimeline runs={runs} routing={routing} now={now} />
      </Panel>
      <Panel
        title="实时日志"
        description="需求级的记录：分诊、写需求文档、写方案，以及人做的操作。"
        bodyClassName="p-3"
      >
        {canSeeDetail('process') ? (
          <LogStream items={own} runs={runs} live={runs.some(isRunning)} {...paging} />
        ) : (
          <HiddenNote what="过程日志" />
        )}
      </Panel>
    </>
  );
}

function SubtaskSection({
  d,
  t,
  s,
  subs,
  routing,
  items,
  now,
  ...paging
}: {
  d: TaskDetail;
  t: BoardTask;
  s: BoardSubtask;
  subs: BoardSubtask[];
  routing: Routing | undefined;
  items: TimelineItem[];
  now: number;
} & LogPaging) {
  const tone = subtaskTone(s);
  const runs: Run[] = d.runs.filter((r) => r.subtaskId === s.id);
  const runIds = new Set(runs.map((r) => r.id));
  const runId = s.activity?.runId ?? latestRun(d.runs, s.id)?.id;
  const steps = useRunSteps(runId);
  const own = items.filter((e) => e.subtaskId === s.id || (e.runId !== undefined && runIds.has(e.runId)));
  const deps = s.dependsOn
    .map((id) => subs.find((x) => x.id === id))
    .filter((x): x is BoardSubtask => Boolean(x))
    .map((x) => letterOf(x.index));
  const list = steps.data?.steps ?? [];
  const done = list.filter((x) => x.state === 'done').length;
  return (
    <>
      <Panel
        title={
          <span className="flex items-center gap-2">
            <span className={cn('num', toneText[tone])}>{letterOf(s.index)}</span>
            {s.title}
            <StatusChip tone={tone} label={subtaskStateLabel[s.state]} />
          </span>
        }
        description={describeSubtask(s, now, subs)}
        actions={<ActionButtons target={targetOf(t, s)} />}
      >
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>步骤清单{runs.length > 1 ? '（当前会话）' : ''}</span>
              {list.length ? (
                <span className="num">
                  {done}/{list.length}
                </span>
              ) : null}
            </div>
            {!canSeeDetail('process') ? (
              <HiddenNote what="步骤清单" />
            ) : list.length ? (
              <>
                <ToneBar value={done / list.length} tone={tone} live={tone === 'run'} className="mb-3" />
                <ol className="space-y-1.5">
                  {list.map((st) => (
                    <li key={st.index} className="flex items-center gap-2 text-sm">
                      {st.state === 'done' ? (
                        <Check className="size-4 shrink-0 text-ink-done" aria-hidden />
                      ) : st.state === 'in_progress' ? (
                        <span className="grid size-4 place-items-center">
                          <StatusDot tone={tone} />
                        </span>
                      ) : (
                        <Circle className="size-4 shrink-0 text-faint" aria-hidden />
                      )}
                      <span
                        className={cn(
                          st.state === 'pending' && 'text-faint',
                          st.state === 'done' && 'text-muted-foreground',
                          st.state === 'in_progress' && 'font-medium',
                        )}
                      >
                        {st.title}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            ) : steps.error ? (
              <p role="alert" className="text-sm text-ink-fail">
                步骤清单没读成：{errorText(steps.error)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {!runId
                  ? '开工后这里会列出会话汇报的步骤。'
                  : steps.isLoading
                    ? '正在读步骤…'
                    : '这个会话还没报步骤清单。'}
              </p>
            )}
            {steps.data?.lastSay ? (
              <p className="mt-3 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs">
                <span className="text-muted-foreground">它最后说：</span>
                {steps.data.lastSay.text}
                <span className="num ml-1 text-muted-foreground">
                  · {formatAgo(steps.data.lastSay.at, now)}
                </span>
              </p>
            ) : null}
          </div>
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-xs text-muted-foreground">会改的地方</div>
              {!canSeeDetail('process') ? (
                <HiddenNote what="要改的文件" />
              ) : s.touches.length ? (
                <ul className="space-y-1">
                  {s.touches.map((p) => (
                    <li key={p} className="num flex items-center gap-1.5 truncate text-xs">
                      <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      {p}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">方案里没写</p>
              )}
              {deps.length ? (
                <p className="mt-2 text-xs text-muted-foreground">先等子任务 {deps.join('、')} 合并</p>
              ) : null}
            </div>
            {s.prNumber ? (
              <div>
                <div className="mb-2 text-xs text-muted-foreground">PR</div>
                <RepoLink
                  repo={d.repo}
                  kind="pull"
                  n={s.prNumber}
                  className="inline-flex items-center gap-2 text-sm [&[href]]:hover:underline"
                  icon={<ExternalLink className="size-3 text-muted-foreground" />}
                >
                  <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
                  <span className="num font-medium">#{s.prNumber}</span>
                  <span className="text-muted-foreground">{subtaskStateLabel[s.state]}</span>
                </RepoLink>
              </div>
            ) : null}
          </div>
        </div>
      </Panel>

      <Panel title="会话时间线" description="斜纹是排队，实色是干活；每一条都写着为什么派给它。">
        <RunTimeline runs={runs} routing={routing} now={now} />
      </Panel>

      <Panel
        title="实时日志"
        description="助手每一步在干什么：读了哪些文件、改了哪里、跑了哪些测试。"
        bodyClassName="p-3"
      >
        {canSeeDetail('process') ? (
          <LogStream items={own} runs={runs} live={runs.some(isRunning)} {...paging} />
        ) : (
          <HiddenNote what="过程日志" />
        )}
      </Panel>
    </>
  );
}
