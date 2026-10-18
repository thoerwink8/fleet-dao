// 任务页「过程」（#3140）：段（对题 / 动手 / 验收，一笔）→ 步骤 → 单个调用 三层。
// 照 Claude 桌面版的 Agent 展示：什么都先收成一行，细节靠点开；颜色只表示语义（绿增、红删和失败、蓝在跑，其余黑白灰）。
// - 一步 = Agent 说的一句话 + 它接着做的那串调用（切法在 shared 的 task-process.ts，后端算好放在任务详情的 overview.process）。
//   步骤行：标题（那句话）、起止时刻、用时、小计（调用、命令、失败、读了几个文件、改了几个文件 +/-）。
// - 有失败的步骤、在跑的步骤默认展开，人点过一次就听人的。展开才去读这一步的调用（只读这一步的序号区间）。
// - 顶上一条时间条，每步一段、宽度按用时比例，失败红、在跑蓝，点一段展开那一步。
// 读不到的写「没读到」和原因：老后端没给 overview、会话内容读不到、这一笔跑在记录之前，都分开写，不画 0。
import type { ProcessStep, RunProcess } from '@fleet-dao/shared';
import { toolClass } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { STEP_CALLS_MAX, useStepCalls } from '../api/client';
import type { TaskDetail, TranscriptEntry } from '../api/types';
import { formatClockSeconds, formatDuration } from '../lib/format';
import {
  liveMs,
  type SegmentRunView,
  segmentLabel,
  segmentOutcomeLabel,
  segmentOutcomeTone,
  UNKNOWN_SEGMENT,
} from '../lib/segments';
import { barWeights, callVerb, stepDurationMs, UNTITLED_STEP, uncountedHint } from '../lib/task-process';
import { cn } from '../lib/utils';
import { EmptyState } from './layout/empty-state';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { StatusBadge } from './layout/status-badge';
import { Clamped, groupEntries } from './run-transcript';
import { Button } from './ui/button';

/** +增 -删 小徽标：绿增、红删，数字等宽；两样都没记就不画（没记不写成 +0 -0）。 */
export function DiffStat({
  added,
  removed,
  title,
}: {
  added: number | undefined;
  removed: number | undefined;
  title?: string | undefined;
}) {
  if (added === undefined && removed === undefined) return null;
  return (
    <span className="num inline-flex shrink-0 items-baseline gap-1 text-meta font-medium" title={title}>
      <span className="text-ink-done">+{added ?? 0}</span>
      <span className="text-ink-fail">-{removed ?? 0}</span>
    </span>
  );
}

const metaInt = (e: TranscriptEntry, key: string): number | undefined => {
  const v = e.meta?.[key];
  return typeof v === 'number' ? v : undefined;
};

/** 单个调用一行：灰色动词 + 对象，改文件带 +/-，失败标红；点开看工具回的结果。 */
function CallRow({
  call,
  result,
  live,
}: {
  call: TranscriptEntry;
  result: TranscriptEntry | undefined;
  live: boolean;
}) {
  const failed = result?.ok === false;
  const state = failed ? 'failed' : result ? 'ok' : live ? 'pending' : 'unknown';
  const cls = toolClass(call.tool);
  const verb = cls === 'agent' ? '' : callVerb(call.tool, state === 'unknown' ? 'ok' : state);
  const [picked, setPicked] = useState<boolean | undefined>(undefined);
  const open = picked ?? failed;
  return (
    <div className="min-w-0 text-body" data-call data-failed={failed ? '' : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPicked(!open)}
        className="flex min-h-8 w-full min-w-0 items-baseline gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-10 max-md:items-center"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 translate-y-0.5 text-muted-foreground max-md:translate-y-0',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        {verb ? (
          <span className={cn('shrink-0', failed ? 'font-medium text-ink-fail' : 'text-muted-foreground')}>
            {verb}
          </span>
        ) : null}
        <span className={cn('num min-w-0 truncate', failed && 'text-ink-fail')} title={call.text}>
          {call.text}
        </span>
        {cls === 'edit' ? (
          <DiffStat added={metaInt(call, 'added')} removed={metaInt(call, 'removed')} />
        ) : null}
        {state === 'unknown' ? (
          <span className="shrink-0 text-meta text-muted-foreground">没读到结果</span>
        ) : null}
      </button>
      {open ? (
        <div
          className={cn(
            'mt-1 mb-1 ml-5 rounded-md border px-2.5 py-1.5',
            failed ? 'border-st-fail-line bg-st-fail-soft' : 'bg-muted',
          )}
          data-call-result
        >
          {result ? (
            <Clamped
              text={result.text || '（无输出）'}
              className="num min-w-0 text-meta break-words whitespace-pre-wrap"
            />
          ) : (
            <span className="text-meta text-muted-foreground">
              {live ? '还没有结果' : '这一笔收场时没有记下结果'}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 一步展开后的调用：只读这一步的序号区间；条目多于一页的写明还有多少，去会话抽屉看全部。 */
function StepCalls({
  taskId,
  runId,
  step,
  live,
  title,
}: {
  taskId: string;
  runId: string;
  step: ProcessStep;
  live: boolean;
  title: string | null;
}) {
  const q = useStepCalls(
    taskId,
    runId,
    { firstSeq: step.firstSeq, lastSeq: step.lastSeq, running: step.running },
    true,
  );
  if (q.isPending) {
    return (
      <p className="flex items-center gap-1.5 py-1 text-meta text-muted-foreground" role="status">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        正在读这一步的调用…
      </p>
    );
  }
  if (q.isError) {
    return (
      <Notice
        tone="fail"
        action={
          <Button type="button" size="xs" variant="outline" onClick={() => void q.refetch()}>
            重试
          </Button>
        }
      >
        <span className="break-words">没读成：{errMessage(q.error).replace(/^没读成[：:]\s*/, '')}</span>
      </Notice>
    );
  }
  const entries = q.data.entries.filter((e) => e.seq >= step.firstSeq && e.seq <= step.lastSeq);
  const items = groupEntries(entries);
  const total = step.lastSeq - step.firstSeq + 1;
  return (
    <div className="space-y-0.5" data-step-calls>
      {items.map((item) => {
        if (item.kind === 'call') {
          const sub = item.call.meta?.subagent !== undefined;
          return (
            <div key={item.call.seq} className={cn(sub && 'ml-4 border-l-2 pl-3')}>
              <CallRow call={item.call} result={item.result} live={live} />
            </div>
          );
        }
        const e = item.entry;
        if (e.kind === 'assistant') {
          // 这一步的标题就是第一句话，不重复；后面补的话、子代理说的话灰字露出来
          if (title !== null && e.text.trim().startsWith(title.replace(/…$/, '').slice(0, 20))) return null;
          return (
            <p
              key={e.seq}
              className={cn(
                'line-clamp-3 px-1 py-0.5 text-meta break-words whitespace-pre-wrap text-muted-foreground',
                e.meta?.subagent !== undefined && 'ml-4 border-l-2 pl-3',
              )}
            >
              {e.text}
            </p>
          );
        }
        if (e.kind === 'error') {
          return (
            <p key={e.seq} role="alert" className="px-1 py-0.5 text-body break-words text-ink-fail">
              <span className="font-medium">报错 </span>
              {e.text}
            </p>
          );
        }
        if (e.kind === 'result') {
          return (
            <p
              key={e.seq}
              className={cn(
                'px-1 py-0.5 text-body font-medium break-words',
                e.ok === false ? 'text-ink-fail' : 'text-ink-done',
              )}
            >
              结论：{e.text}
            </p>
          );
        }
        return null;
      })}
      {total > STEP_CALLS_MAX && q.data.entries.length >= STEP_CALLS_MAX ? (
        <p className="px-1 text-meta text-muted-foreground">
          这一步一共 {total} 条，这里只读了前 {STEP_CALLS_MAX} 条，全部在「看会话」里。
        </p>
      ) : null}
    </div>
  );
}

/** 一步的小计：灰字，用「·」隔开；失败数标红，读了几个文件、改了几个文件 +/- 带徽标。 */
export function StepTally({ step }: { step: ProcessStep }) {
  const parts: ReactNode[] = [];
  if (step.calls > 0) parts.push(<span key="calls">{step.calls} 个调用</span>);
  if (step.commands > 0) parts.push(<span key="cmd">{step.commands} 个命令</span>);
  if (step.callsFailed > 0)
    parts.push(
      <span key="fail" className="font-medium text-ink-fail" data-step-failed-count>
        {step.callsFailed} 个失败
      </span>,
    );
  if (step.commandsUnknown > 0)
    parts.push(
      <span key="unk" title="这一笔收场了，这几个命令没有记下结果">
        {step.commandsUnknown} 个没读到结果
      </span>,
    );
  if (step.reads > 0) parts.push(<span key="read">读 {step.reads} 个文件</span>);
  if (step.files.length > 0)
    parts.push(
      <span key="files" className="inline-flex items-baseline gap-1">
        改 {step.files.length} 个文件
        <DiffStat
          added={step.files.some((f) => f.added !== undefined) ? step.added : undefined}
          removed={step.files.some((f) => f.removed !== undefined) ? step.removed : undefined}
          title={uncountedHint(step.uncounted)}
        />
        {step.files.every((f) => f.added === undefined) ? (
          <span title="这几次编辑没有记行数">没记行数</span>
        ) : null}
      </span>,
    );
  return (
    <>
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 固定顺序的几段，p 自己带 key
        <span key={i} className="inline-flex items-baseline gap-1.5">
          {i > 0 ? (
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
          ) : null}
          {p}
        </span>
      ))}
    </>
  );
}

function StepRow({
  taskId,
  runId,
  step,
  now,
  open,
  onToggle,
  live,
}: {
  taskId: string;
  runId: string;
  step: ProcessStep;
  now: number;
  open: boolean;
  onToggle: () => void;
  live: boolean;
}) {
  const dur = stepDurationMs(step, now);
  const title = step.title;
  return (
    <li
      id={`step-${runId}-${step.index}`}
      data-step={step.index}
      data-failed={step.failed ? '' : undefined}
      data-running={step.running ? '' : undefined}
      className="min-w-0"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full min-w-0 flex-col gap-0.5 px-4 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-muted-foreground', open && 'rotate-90')}
            aria-hidden
          />
          <span
            className={cn(
              'min-w-0 truncate text-body font-medium',
              title === null && 'font-normal text-muted-foreground',
            )}
            title={title ?? UNTITLED_STEP}
            data-step-title
          >
            {title ?? UNTITLED_STEP}
          </span>
          {step.running ? <StatusBadge tone="run" variant="dot" label="在跑" className="ml-auto" /> : null}
          {step.failed ? (
            <StatusBadge tone="fail" variant="dot" label="有失败" className={step.running ? '' : 'ml-auto'} />
          ) : null}
        </span>
        <span
          className="num flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 pl-5 text-meta text-muted-foreground"
          data-step-meta
        >
          <span data-step-time>
            {formatClockSeconds(step.startedAt)}–{step.endedAt ? formatClockSeconds(step.endedAt) : '现在'}
          </span>
          <span aria-hidden>·</span>
          <span data-step-duration>用时 {formatDuration(dur)}</span>
          <StepTallyLead step={step} />
        </span>
      </button>
      {open ? (
        <div className="pr-4 pb-2 pl-10 max-md:pl-8">
          <StepCalls taskId={taskId} runId={runId} step={step} live={live} title={title} />
        </div>
      ) : null}
    </li>
  );
}

/** 小计前面补一个「·」（和用时隔开）；没有小计就什么也不画。 */
function StepTallyLead({ step }: { step: ProcessStep }) {
  if (step.calls === 0 && step.files.length === 0 && step.reads === 0) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <StepTally step={step} />
    </>
  );
}

/** 顶上的时间条：每步一段，宽度按用时比例；失败红、在跑蓝、其余灰；点一段展开那一步。 */
function TimeBar({
  steps,
  now,
  onPick,
}: {
  steps: readonly ProcessStep[];
  now: number;
  onPick: (index: number) => void;
}) {
  if (steps.length < 2) return null;
  const weights = barWeights(steps, now);
  return (
    <ul className="flex h-2 gap-px overflow-hidden rounded-full" aria-label="每一步各占多久" data-time-bar>
      {steps.map((s, i) => (
        <li key={s.index} className="flex min-w-1" style={{ flex: `${weights[i] ?? 1} 1 0` }}>
          <button
            type="button"
            onClick={() => onPick(s.index)}
            title={`${s.title ?? UNTITLED_STEP}：${formatDuration(stepDurationMs(s, now))}`}
            aria-label={`第 ${s.index + 1} 步：${s.title ?? UNTITLED_STEP}，用时 ${formatDuration(stepDurationMs(s, now))}`}
            data-bar-step={s.index}
            className={cn(
              'w-full hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              s.failed ? 'bg-st-fail' : s.running ? 'bg-st-run' : 'bg-border-strong',
            )}
          />
        </li>
      ))}
    </ul>
  );
}

/** 这一笔里要默认展开的步骤：有失败的、在跑的。 */
export function defaultOpenSteps(steps: readonly ProcessStep[]): Set<number> {
  return new Set(steps.filter((s) => s.failed || s.running).map((s) => s.index));
}

/** 一笔的「过程」：头一行（段、第几次、模型、结局、用时、小计、看会话），展开是时间条 + 步骤。 */
function RunProcessGroup({
  d,
  run,
  nth,
  entry,
  now,
  startOpen,
  onViewTranscript,
}: {
  d: TaskDetail;
  run: SegmentRunView;
  nth: number;
  entry: { noRecord: boolean; process?: RunProcess | undefined };
  now: number;
  startOpen: boolean;
  onViewTranscript: (runId: string) => void;
}) {
  const [picked, setPicked] = useState<boolean | undefined>(undefined);
  const proc = entry.process;
  const hasFailure = Boolean(proc?.steps.some((s) => s.failed));
  const open = picked ?? (startOpen || hasFailure || run.running);
  const [stepPicks, setStepPicks] = useState<Record<number, boolean>>({});
  const auto = proc ? defaultOpenSteps(proc.steps) : new Set<number>();
  const stepOpen = (i: number) => stepPicks[i] ?? auto.has(i);
  const live = liveMs(run, now);
  const dur = run.durationMs ?? live;
  const label = run.segment ? segmentLabel[run.segment] : UNKNOWN_SEGMENT;
  return (
    <li data-run-process={run.id} data-open={open ? '' : undefined} className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 px-4 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setPicked(!open)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-10"
        >
          <ChevronRight
            className={cn('size-4 shrink-0 text-muted-foreground', open && 'rotate-90')}
            aria-hidden
          />
          <span className="text-body font-semibold">{label}</span>
          <span className="num text-meta text-muted-foreground">第 {nth} 次</span>
          <span className="num min-w-0 truncate text-body">{run.modelName}</span>
          {run.running ? (
            <StatusBadge tone="run" label="在跑" />
          ) : run.outcome ? (
            <StatusBadge tone={segmentOutcomeTone[run.outcome]} label={segmentOutcomeLabel[run.outcome]} />
          ) : (
            <StatusBadge tone="stall" label="结局没读到" />
          )}
          <span className="num text-meta text-muted-foreground">
            {dur !== undefined ? formatDuration(dur) : '耗时没读到'}
          </span>
          {proc ? (
            <span
              className="num flex flex-wrap items-baseline gap-x-1.5 text-meta text-muted-foreground"
              data-run-tally
            >
              {proc.steps.length} 步
              {proc.counts.commands > 0 ? <span>· {proc.counts.commands} 个命令</span> : null}
              {proc.counts.commandsFailed > 0 ? (
                <span className="font-medium text-ink-fail">· {proc.counts.commandsFailed} 个失败</span>
              ) : null}
              {proc.counts.files.length > 0 ? (
                <span className="inline-flex items-baseline gap-1">
                  · 改 {proc.counts.files.length} 个文件
                  <DiffStat
                    added={
                      proc.counts.files.some((f) => f.added !== undefined) ? proc.counts.added : undefined
                    }
                    removed={
                      proc.counts.files.some((f) => f.removed !== undefined) ? proc.counts.removed : undefined
                    }
                    title={uncountedHint(proc.counts.uncounted)}
                  />
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={() => onViewTranscript(run.id)}
        >
          看会话
        </Button>
      </div>
      {open ? (
        <div className="pb-2" data-run-body>
          {entry.noRecord ? (
            <p className="px-4 pb-1 pl-10 text-body text-muted-foreground" data-no-record>
              这一笔跑在记录会话内容之前，没有过程记录
            </p>
          ) : proc && proc.steps.length === 0 ? (
            <p className="px-4 pb-1 pl-10 text-body text-muted-foreground">
              {run.running ? '会话刚起来，还没有内容。' : '这一笔没有可分步的内容（只有提示词）。'}
            </p>
          ) : proc ? (
            <>
              <div className="px-4 pb-1 pl-10 max-md:pl-8">
                <TimeBar
                  steps={proc.steps}
                  now={now}
                  onPick={(i) => {
                    setStepPicks((p) => ({ ...p, [i]: true }));
                    document.getElementById(`step-${run.id}-${i}`)?.scrollIntoView({ block: 'nearest' });
                  }}
                />
              </div>
              <ol className="divide-y divide-border" aria-label="步骤">
                {proc.steps.map((s) => (
                  <StepRow
                    key={s.index}
                    taskId={d.task.id}
                    runId={run.id}
                    step={s}
                    now={now}
                    open={stepOpen(s.index)}
                    onToggle={() => setStepPicks((p) => ({ ...p, [s.index]: !stepOpen(s.index) }))}
                    live={run.running}
                  />
                ))}
              </ol>
              {proc.truncated ? (
                <p className="px-4 pt-1 pl-10 text-meta text-muted-foreground">
                  这一笔到了每段 3000 条的记录上限，后面的没记。
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** 「过程」整块：每一笔一组。 */
export function TaskProcess({
  d,
  now,
  onViewTranscript,
}: {
  d: TaskDetail;
  now: number;
  onViewTranscript: (runId: string) => void;
}) {
  const o = d.overview;
  const nthOf = (id: string) => {
    const i = d.segmentRuns.findIndex((r) => r.id === id);
    const run = d.segmentRuns[i];
    return run ? d.segmentRuns.slice(0, i + 1).filter((r) => r.segment === run.segment).length : 1;
  };
  let body: ReactNode;
  if (!o) {
    body = (
      <div className="p-4">
        <Notice tone="info">这台后端还没有「过程」这一项（老版本推来的详情），分步的过程没读到。</Notice>
      </div>
    );
  } else if (o.process.state === 'unavailable') {
    body = (
      <div className="p-4">
        <Notice tone="stall" title="过程没读到">
          <span className="break-words">{o.process.reason}</span>
        </Notice>
      </div>
    );
  } else if (o.process.runs.length === 0) {
    body = <EmptyState title="还没有过程" hint="三段跑起来以后，每一步都记在这里。" />;
  } else {
    const processByRun = new Map(o.process.runs.map((r) => [r.runId, r]));
    const lastId = d.segmentRuns.at(-1)?.id;
    body = (
      <ol className="divide-y" aria-label="按笔的过程">
        {d.segmentRuns.map((run) => {
          const entry = processByRun.get(run.id);
          if (!entry) return null;
          return (
            <RunProcessGroup
              key={run.id}
              d={d}
              run={run}
              nth={nthOf(run.id)}
              entry={entry}
              now={now}
              startOpen={run.id === lastId}
              onViewTranscript={onViewTranscript}
            />
          );
        })}
      </ol>
    );
  }
  return (
    <Section
      title="过程"
      description="每一笔分步，点开看调用；有失败、在跑的自动展开"
      flush
      data-task-process
    >
      {body}
    </Section>
  );
}
