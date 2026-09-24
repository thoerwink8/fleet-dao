// 看板右侧的详情：单击卡片打开。看板数据里没有的（原话、会话、步骤清单）按需从任务详情和步骤接口拉。
import { ArrowUpRight, Check, Circle, FileCode2, GitPullRequest, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { errorText, useRunSteps, useTaskDetail } from '../api/client';
import type { Board, BoardSubtask, BoardTask, Routing, Run } from '../api/types';
import { StatusChip, StatusDot } from '../components/status';
import { ActionButtons, targetOf } from '../components/task-actions';
import { Button } from '../components/ui/button';
import { ScrollArea } from '../components/ui/scroll-area';
import { routeInfo, stageLabel } from '../lib/catalog';
import { formatAgo, formatDuration } from '../lib/format';
import { useNow } from '../lib/hooks';
import { taskPhases } from '../lib/phases';
import {
  describeSubtask,
  describeTask,
  isRunning,
  latestRun,
  letterOf,
  queueMs,
  subtaskStateLabel,
  subtaskTone,
  taskStateLabel,
  taskTone,
  toneText,
  workMs,
} from '../lib/status';
import { cn } from '../lib/utils';
import { hrefOf } from './board-ui';
import type { BoardNodeData } from './model';
import { prState } from './nodes';

export function DetailPanel({
  data,
  board,
  routing,
  onClose,
  onSelect,
}: {
  data: BoardNodeData;
  board: Board;
  routing: Routing | undefined;
  onClose(): void;
  onSelect(nodeId: string): void;
}) {
  return (
    <motion.aside
      key="detail"
      initial={{ opacity: 0, x: 28 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 28 }}
      transition={{ type: 'spring', stiffness: 420, damping: 38 }}
      className="absolute top-3 right-3 bottom-3 z-20 flex w-[392px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-2xl border bg-popover/95 shadow-2xl backdrop-blur-xl"
      aria-label="详情"
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {data.kind === 'task' ? (
            <TaskPanel t={data.task} routing={routing} onSelect={onSelect} onClose={onClose} />
          ) : null}
          {data.kind === 'sub' || data.kind === 'pr' ? (
            <SubPanel
              board={board}
              task={data.task}
              s={data.sub}
              letter={data.letter}
              routing={routing}
              onClose={onClose}
            />
          ) : null}
          {data.kind === 'repo' ? (
            <div>
              <Head onClose={onClose}>
                <span className="num text-sm text-muted-foreground">
                  {data.repo.owner}/{data.repo.name}
                </span>
              </Head>
              <p className="mt-3 text-sm text-muted-foreground">
                {data.counts.total} 个需求：在跑 {data.counts.running}，卡住 {data.counts.stuck}，等你{' '}
                {data.counts.human}，已完成 {data.counts.done}。
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between gap-2 border-t bg-card/60 px-4 py-2.5">
        <span className="text-[11px] text-muted-foreground">
          双击卡片或按 <kbd className="num">O</kbd> 进后台页
        </span>
        <Button asChild size="sm" variant="secondary">
          <Link to={hrefOf(data)}>
            打开
            <ArrowUpRight />
          </Link>
        </Button>
      </footer>
    </motion.aside>
  );
}

function Head({ children, onClose }: { children: ReactNode; onClose(): void }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <Button size="icon" variant="ghost" className="ml-auto size-7" onClick={onClose} aria-label="关闭详情">
        <X />
      </Button>
    </div>
  );
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-5', className)}>
      <h3 className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function TaskPanel({
  t,
  routing,
  onSelect,
  onClose,
}: {
  t: BoardTask;
  routing: Routing | undefined;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const now = useNow();
  const tone = taskTone(t);
  const detail = useTaskDetail(t.id);
  const subs = [...t.subtasks].sort((a, b) => a.index - b.index);
  return (
    <div>
      <Head onClose={onClose}>
        <span className="num text-sm font-semibold text-muted-foreground">#{t.issueNumber}</span>
        <StatusChip tone={tone} label={taskStateLabel[t.state]} />
      </Head>
      <h2 className="mt-2 text-lg leading-snug font-semibold">{t.title}</h2>
      <p className={cn('mt-1 text-sm', tone === 'run' ? 'text-muted-foreground' : toneText[tone])}>
        {describeTask(t, now)}
      </p>
      <div className="mt-3">
        <ActionButtons target={targetOf(t)} />
      </div>

      <Section title="原话">
        {detail.data ? (
          <blockquote className="rounded-lg border-l-2 border-border-strong bg-muted/60 px-3 py-2 text-sm whitespace-pre-wrap">
            {detail.data.task.rawRequest}
            <div className="mt-1 text-xs text-muted-foreground">
              {t.requestedBy} · {formatAgo(t.createdAt, now)}
            </div>
          </blockquote>
        ) : detail.error ? (
          <p role="alert" className="text-xs text-st-fail">
            原话没读成：{errorText(detail.error)}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">正在读原话…</p>
        )}
      </Section>

      <Section title="阶段">
        <ol className="space-y-1.5">
          {taskPhases(t, now).map((p) => {
            const info = routing && p.routeId ? routeInfo(routing, p.routeId) : undefined;
            return (
              <li key={p.key} className="flex items-center gap-2 text-[13px]">
                <StatusDot tone={p.state === 'pending' ? 'wait' : p.tone} />
                <span className="w-8 shrink-0 text-muted-foreground">{p.label}</span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {p.modelName ? (
                    <>
                      <span className="num">{p.modelName}</span>
                      {info ? (
                        <span className="text-muted-foreground">
                          {' '}
                          · {info.channel} {info.poolId}
                        </span>
                      ) : null}
                      {p.detail ? <span className="text-muted-foreground"> · {p.detail}</span> : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      {p.detail ?? (p.state === 'pending' ? '还没到' : '')}
                    </span>
                  )}
                </span>
                <span className="num text-xs text-muted-foreground">{p.ms ? formatDuration(p.ms) : ''}</span>
              </li>
            );
          })}
        </ol>
      </Section>

      {subs.length ? (
        <Section title={`子任务（${subs.length}）`}>
          <ul className="space-y-1.5">
            {subs.map((s) => {
              const st = subtaskTone(s);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(`sub:${s.id}`)}
                    className="w-full rounded-lg border px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-accent"
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn('num text-xs font-bold', toneText[st])}>{letterOf(s.index)}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.title}</span>
                      <StatusChip tone={st} label={subtaskStateLabel[s.state]} />
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {describeSubtask(s, now, subs)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function RunLine({ run, routing, now }: { run: Run; routing: Routing | undefined; now: number }) {
  const info = routing ? routeInfo(routing, run.routeId) : undefined;
  const live = isRunning(run);
  return (
    <li className="rounded-lg border px-3 py-2">
      <div className="flex items-center gap-2 text-[13px]">
        <StatusDot
          tone={
            live
              ? 'run'
              : !run.endedAt
                ? 'wait'
                : run.outcome === 'ok'
                  ? 'done'
                  : run.outcome === 'failed'
                    ? 'fail'
                    : run.outcome === 'stalled'
                      ? 'stall'
                      : 'stop'
          }
        />
        <span className="text-muted-foreground">{stageLabel[run.stage]}</span>
        <span className="num truncate font-medium">{run.modelName}</span>
        <span className="num ml-auto shrink-0 text-xs text-muted-foreground">
          排 {formatDuration(queueMs(run, now))} · 干 {run.startedAt ? formatDuration(workMs(run, now)) : '—'}
        </span>
      </div>
      {info ? (
        <div className="mt-1 text-xs text-muted-foreground">
          {info.channel} {info.poolId} · {info.host}
        </div>
      ) : null}
      <div className="mt-1 text-xs">
        <span className="text-muted-foreground">为什么派给它：</span>
        {run.whyRoute}
      </div>
    </li>
  );
}

function SubPanel({
  board,
  task,
  s,
  letter,
  routing,
  onClose,
}: {
  board: Board;
  task: BoardTask;
  s: BoardSubtask;
  letter: string;
  routing: Routing | undefined;
  onClose(): void;
}) {
  const now = useNow();
  const tone = subtaskTone(s);
  const detail = useTaskDetail(task.id);
  const runs = (detail.data?.runs ?? []).filter((r) => r.subtaskId === s.id);
  const runId = s.activity?.runId ?? latestRun(runs, s.id)?.id;
  const steps = useRunSteps(runId);
  const deps = s.dependsOn
    .map((d) => task.subtasks.find((x) => x.id === d))
    .filter((x): x is BoardSubtask => Boolean(x))
    .map((x) => letterOf(x.index));
  const pr = prState(s);
  return (
    <div>
      <Head onClose={onClose}>
        <span className="num text-sm font-semibold text-muted-foreground">
          #{task.issueNumber} · {letter}
        </span>
        <StatusChip tone={tone} label={subtaskStateLabel[s.state]} />
      </Head>
      <h2 className="mt-2 text-lg leading-snug font-semibold">{s.title}</h2>
      <p className={cn('mt-1 text-sm', tone === 'run' ? 'text-muted-foreground' : toneText[tone])}>
        {describeSubtask(s, now, task.subtasks)}
      </p>
      <div className="mt-3">
        <ActionButtons target={targetOf(task, s)} />
      </div>

      <Section title="步骤清单">
        {steps.data?.steps.length ? (
          <ol className="space-y-1">
            {steps.data.steps.map((st) => (
              <li key={st.index} className="flex items-center gap-2 text-[13px]">
                {st.state === 'done' ? (
                  <Check className="size-3.5 text-st-done" aria-hidden />
                ) : st.state === 'in_progress' ? (
                  <StatusDot tone={tone} className="mx-[3px]" />
                ) : (
                  <Circle className="size-3.5 text-faint" aria-hidden />
                )}
                <span
                  className={cn(
                    st.state === 'pending' && 'text-faint',
                    st.state === 'done' && 'text-muted-foreground',
                  )}
                >
                  {st.title}
                </span>
              </li>
            ))}
          </ol>
        ) : steps.error || (!runId && detail.error) ? (
          <p role="alert" className="text-xs text-st-fail">
            步骤清单没读成：{errorText(steps.error ?? detail.error)}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {!runId
              ? detail.isLoading
                ? '正在读会话…'
                : '还没有会话'
              : steps.isLoading
                ? '正在读步骤…'
                : '这个会话还没报步骤清单'}
          </p>
        )}
        {steps.data?.lastSay ? (
          <p className="mt-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs">
            <span className="text-muted-foreground">它最后说：</span>
            {steps.data.lastSay.text}
            <span className="num ml-1 text-muted-foreground">· {formatAgo(steps.data.lastSay.at, now)}</span>
          </p>
        ) : null}
      </Section>

      {detail.error ? (
        <Section title="会话">
          <p role="alert" className="text-xs text-st-fail">
            会话没读成：{errorText(detail.error)}
          </p>
        </Section>
      ) : runs.length ? (
        <Section title="会话">
          <ul className="space-y-1.5">
            {[...runs]
              .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
              .map((r) => (
                <RunLine key={r.id} run={r} routing={routing} now={now} />
              ))}
          </ul>
        </Section>
      ) : null}

      <Section title="会改的地方">
        {s.touches.length ? (
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
      </Section>

      {s.prNumber ? (
        <Section title="PR">
          <a
            href={`https://github.com/${board.repo.owner}/${board.repo.name}/pull/${s.prNumber}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 text-sm hover:underline"
          >
            <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
            <span className="num font-medium">#{s.prNumber}</span>
            <span className="text-muted-foreground">{pr.text}</span>
            <ArrowUpRight className="size-3.5 text-muted-foreground" aria-hidden />
          </a>
        </Section>
      ) : null}
    </div>
  );
}
