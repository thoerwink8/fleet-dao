// 任务页「过程」（#3140）：回合 → 笔 → 步骤 → 调用 四层，照引擎实际走法排。
// 照 Claude 桌面版的 Agent 展示：什么都先收成一行，细节靠点开；颜色只表示语义（绿增、红删和失败、蓝在跑，其余黑白灰）。
// - 回合：一次「动手 → 自测 → 推分支 → CI → 验收」（task_rounds）。返工回合顶上写为什么返工；老记录没记回合的单列一组。
// - 笔：一次起会话（runs 的一行）。写为什么起、新会话还是接上一笔的会话、结局、用时、小计；笔之间写引擎在会话外做的事
//   （自测、推分支、开 PR、等 CI、验收、合并），连着的等待折成一行。
// - 步骤：Agent 说的一句话 + 它接着做的那串调用（切法在 shared 的 task-process.ts，后端按笔现算，展开这一笔才去读）。
//   步骤行：标题、起止时刻、用时、小计；有失败的、在跑的默认展开，人点过一次就听人的。
// - 调用：展开一步才去读这一步的序号区间。
// - 顶上一条时间条，看每笔各占多久。
// 读不到的写「没读到」和原因：老后端没给 overview、哪一块读不了、这一笔跑在记录之前，都分开写，不画 0。
import { toolClass } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { STEP_CALLS_MAX, useRunProcess, useStepCalls } from '../api/client';
import type { ProcessStep, RunTally, TaskDetail, TranscriptEntry } from '../api/types';
import { formatClockSeconds, formatDuration } from '../lib/format';
import {
  runNth,
  type SegmentRunView,
  segmentLabel,
  segmentOutcomeLabel,
  segmentOutcomeTone,
  UNKNOWN_SEGMENT,
} from '../lib/segments';
import {
  ACTIVITY_LABEL,
  barWeights,
  buildTimeline,
  callVerb,
  causeLabel,
  type RoundGroup,
  reworkDetail,
  roundDurationMs,
  roundOutcome,
  runDurationMs,
  sessionLink,
  stepDurationMs,
  type TimelineItem,
  UNTITLED_STEP,
  uncountedHint,
  waitLabel,
} from '../lib/task-process';
import { cn } from '../lib/utils';
import { DiffStat } from './diff-stat';
import { EmptyState } from './layout/empty-state';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { StatusBadge } from './layout/status-badge';
import { Clamped, groupEntries } from './run-transcript';
import { Button } from './ui/button';

export { DiffStat };

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
  // 命令没有可信的退出码（Mirasim 的流里没有）：结果是「完成」，不是「成功」
  const exitUnknown = cls === 'command' && result?.meta?.exitKnown === false;
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
        {cls === 'edit' && result ? (
          <DiffStat added={metaInt(result, 'added')} removed={metaInt(result, 'removed')} />
        ) : null}
        {state === 'unknown' ? (
          <span className="shrink-0 text-meta text-muted-foreground">没读到结果</span>
        ) : exitUnknown ? (
          <span
            className="shrink-0 text-meta text-muted-foreground"
            title="这一家的流里没有命令的退出码：只知道命令跑完了，成没成不知道"
          >
            结果未知
          </span>
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
      <span key="unk" title="命令没有结果：老记录对不上、笔收场了没记下、这一家的流里没有退出码">
        {step.commandsUnknown} 个结果未知
      </span>,
    );
  if (step.reads > 0) parts.push(<span key="read">读 {step.reads} 次文件</span>);
  if (step.files.length > 0) {
    const anyCounted = step.files.some((f) => f.added !== undefined || f.removed !== undefined);
    parts.push(
      <span key="files" className="inline-flex items-baseline gap-1">
        改 {step.files.length} 个文件
        {anyCounted ? (
          <DiffStat added={step.added} removed={step.removed} title={uncountedHint(step.uncounted)} />
        ) : (
          <span title="这几次编辑没有记行数">没记行数</span>
        )}
      </span>,
    );
  }
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
  const hasTally = step.calls > 0 || step.files.length > 0 || step.reads > 0;
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
          {hasTally ? (
            <>
              <span aria-hidden>·</span>
              <StepTally step={step} />
            </>
          ) : null}
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

/** 这一笔里要默认展开的步骤：有失败的、在跑的。 */
export function defaultOpenSteps(steps: readonly ProcessStep[]): Set<number> {
  return new Set(steps.filter((s) => s.failed || s.running).map((s) => s.index));
}

/** 一笔里每一步一段的时间条：失败红、在跑蓝、其余灰；点一段展开那一步。 */
function StepBar({
  steps,
  now,
  onPick,
}: {
  steps: readonly ProcessStep[];
  now: number;
  onPick: (index: number) => void;
}) {
  if (steps.length < 2) return null;
  const weights = barWeights(steps.map((s) => stepDurationMs(s, now)));
  return (
    <ul className="flex h-2 gap-px overflow-hidden rounded-full" aria-label="每一步各占多久" data-step-bar>
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

/** 笔头一行的小计：命令几个、失败几个、改了几次文件 +/-；读不到小计的整行不写（概览顶上已写了原因）。 */
function RunTallyLine({ tally, running }: { tally: RunTally; running: boolean }) {
  const anyCounted = tally.added > 0 || tally.removed > 0;
  const bits: ReactNode[] = [];
  if (tally.commands > 0) bits.push(<span key="cmd">{tally.commands} 个命令</span>);
  if (tally.commandsFailed > 0)
    bits.push(
      <span key="fail" className="font-medium text-ink-fail">
        {tally.commandsFailed} 个失败
      </span>,
    );
  if (tally.commandsRunning > 0 && running)
    bits.push(
      <span key="run" className="text-ink-run">
        {tally.commandsRunning} 个在跑
      </span>,
    );
  if (tally.commandsUnknown > 0)
    bits.push(
      <span key="unk" title="命令没有结果：老记录对不上、笔收场了没记下、这一家的流里没有退出码">
        {tally.commandsUnknown} 个结果未知
      </span>,
    );
  if (tally.editsOk > 0)
    bits.push(
      <span key="edit" className="inline-flex items-baseline gap-1">
        改 {tally.editsOk} 次
        {anyCounted ? (
          <DiffStat added={tally.added} removed={tally.removed} title={uncountedHint(tally.uncounted)} />
        ) : (
          <span title="这几次编辑没有记行数">没记行数</span>
        )}
      </span>,
    );
  if (bits.length === 0) return null;
  return (
    <span
      className="num flex flex-wrap items-baseline gap-x-1.5 text-meta text-muted-foreground"
      data-run-tally
    >
      {bits.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 固定顺序的几段，b 自己带 key
        <span key={i} className="inline-flex items-baseline gap-1.5">
          {i > 0 ? (
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
          ) : null}
          {b}
        </span>
      ))}
    </span>
  );
}

/** 验收那一笔的结论：过没过、没过的问题、转给人的。 */
function Verdict({ verdict }: { verdict: NonNullable<SegmentRunView['verdict']> }) {
  return (
    <div className="px-4 pb-2 pl-10 max-md:pl-8" data-verdict>
      <p className={cn('text-body font-medium', verdict.pass ? 'text-ink-done' : 'text-ink-fail')}>
        {verdict.pass ? '验收通过' : '验收没过'}
        {verdict.failedCriteria.length > 0 ? `（第 ${verdict.failedCriteria.join('、')} 条）` : ''}
      </p>
      {verdict.problems.length > 0 ? (
        <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-meta text-muted-foreground">
          {verdict.problems.map((p) => (
            <li key={p} className="break-words">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      {verdict.handedOver.length > 0 ? (
        <p className="mt-0.5 text-meta text-muted-foreground">转给人：{verdict.handedOver.join('；')}</p>
      ) : null}
    </div>
  );
}

/** 一笔展开后的内容：结论（验收）、这一笔的步骤；这一笔展开才去读。 */
function RunBody({
  d,
  run,
  now,
  noRecordKnown,
}: {
  d: TaskDetail;
  run: SegmentRunView;
  now: number;
  /** 概览里这一笔没有小计（收场了、一条记录都没有）：不用再等接口就知道没有过程记录。 */
  noRecordKnown: boolean;
}) {
  const q = useRunProcess(d.task.id, run.id, run.running, !noRecordKnown);
  const [stepPicks, setStepPicks] = useState<Record<number, boolean>>({});
  const body = (() => {
    if (noRecordKnown || (q.data && q.data.state === 'noRecord')) {
      return (
        <p className="px-4 pb-1 pl-10 text-body text-muted-foreground" data-no-record>
          这一笔跑在记录会话内容之前，没有过程记录
        </p>
      );
    }
    if (q.isPending) {
      return (
        <p className="flex items-center gap-1.5 px-4 pl-10 text-meta text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          正在读这一笔的步骤…
        </p>
      );
    }
    if (q.isError) {
      return (
        <div className="px-4 pl-10">
          <Notice
            tone="fail"
            title="这一笔的步骤没读到"
            action={
              <Button type="button" size="xs" variant="outline" onClick={() => void q.refetch()}>
                重试
              </Button>
            }
          >
            <span className="break-words">{errMessage(q.error).replace(/^没读成[：:]\s*/, '')}</span>
          </Notice>
        </div>
      );
    }
    if (q.data.state !== 'ok') return null;
    const proc = q.data.process;
    const auto = defaultOpenSteps(proc.steps);
    const stepOpen = (i: number) => stepPicks[i] ?? auto.has(i);
    if (proc.steps.length === 0) {
      return (
        <p className="px-4 pb-1 pl-10 text-body text-muted-foreground">
          {run.running ? '会话刚起来，还没有内容。' : '这一笔没有可分步的内容（只有提示词）。'}
        </p>
      );
    }
    return (
      <>
        {proc.legacyCalls > 0 ? (
          <p className="px-4 pb-1 pl-10 text-meta text-muted-foreground" data-legacy-note>
            老记录有 {proc.legacyCalls} 个调用没有调用号，对不上结果，命令成败写「结果未知」。
          </p>
        ) : null}
        <div className="px-4 pb-1 pl-10 max-md:pl-8">
          <StepBar
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
    );
  })();
  return (
    <div className="pb-2" data-run-body>
      {run.verdict ? <Verdict verdict={run.verdict} /> : null}
      {body}
    </div>
  );
}

/** 一笔：头一行（段、为什么起、新会话还是接上、模型、结局、用时、小计、看会话），展开是这一笔的步骤。 */
function RunRow({
  d,
  run,
  tally,
  now,
  startOpen,
  onViewTranscript,
}: {
  d: TaskDetail;
  run: SegmentRunView;
  /** 概览里这一笔的小计；undefined = 概览没给（读不到，或这一笔一条记录都没有）。 */
  tally: RunTally | undefined;
  now: number;
  startOpen: boolean;
  onViewTranscript: (runId: string) => void;
}) {
  const failedOutcome = run.outcome !== undefined && segmentOutcomeTone[run.outcome] === 'fail';
  const hasFailure = failedOutcome || (tally?.callsFailed ?? 0) > 0;
  const [picked, setPicked] = useState<boolean | undefined>(undefined);
  const open = picked ?? (startOpen || hasFailure || run.running);
  const cause = causeLabel(run);
  const link = sessionLink(run);
  const label = run.segment ? segmentLabel[run.segment] : UNKNOWN_SEGMENT;
  const nth = runNth(d.segmentRuns, run.id) ?? 1;
  const dur = runDurationMs(run, now);
  // 收场了、概览里没有这一笔的小计：库里一条记录都没有（跑在记录会话内容之前）；概览读不到小计时不下这个结论
  const noRecordKnown = d.overview?.tally.state === 'ok' && tally === undefined && !run.running;
  return (
    <li data-run-process={run.id} data-open={open ? '' : undefined} className="min-w-0">
      <div className="flex min-w-0 items-start gap-2 px-4 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setPicked(!open)}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-10"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <ChevronRight
              className={cn('size-4 shrink-0 text-muted-foreground', open && 'rotate-90')}
              aria-hidden
            />
            <span className="text-body font-semibold">{label}</span>
            <span className="num text-meta text-muted-foreground">第 {nth} 次</span>
            {cause ? (
              <span
                className={cn('text-body', cause.recorded ? '' : 'text-muted-foreground')}
                data-run-cause={run.cause ?? 'unrecorded'}
              >
                {cause.text}
              </span>
            ) : null}
            {link ? (
              <span className="text-meta text-muted-foreground" data-run-link>
                {link}
              </span>
            ) : null}
            <span className="num min-w-0 truncate text-meta text-muted-foreground">{run.modelName}</span>
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
          </span>
          {run.causeSummary ? (
            <span
              className="min-w-0 truncate pl-6 text-meta text-muted-foreground"
              title={run.causeSummary}
              data-run-cause-summary
            >
              {run.causeSummary}
            </span>
          ) : null}
          {tally ? (
            <span className="pl-6">
              <RunTallyLine tally={tally} running={run.running} />
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
      {open ? <RunBody d={d} run={run} now={now} noRecordKnown={noRecordKnown} /> : null}
    </li>
  );
}

/** 笔之间引擎在会话外做的一件事：一行，灰字；没成的标红。 */
function EngineRow({ step }: { step: Extract<TimelineItem, { kind: 'engine' }>['step'] }) {
  const label = ACTIVITY_LABEL[step.activity] ?? step.activity;
  const failed = step.outcome !== 'ok';
  return (
    <li
      data-engine={step.activity}
      data-failed={failed ? '' : undefined}
      className="flex min-w-0 items-baseline gap-2 px-4 py-1 pl-10 text-meta text-muted-foreground max-md:pl-8"
    >
      <span className="num shrink-0">{formatClockSeconds(step.startedAt)}</span>
      <span className={cn('min-w-0 truncate', failed && 'font-medium text-ink-fail')}>
        引擎：{label}
        {step.attempt > 1 ? `（第 ${step.attempt} 次）` : ''}
        {failed
          ? step.outcome === 'cancelled'
            ? ' 被取消'
            : ` 没成${step.errorCode ? `：${step.errorCode}` : ''}`
          : ''}
      </span>
      <span className="num shrink-0">{formatDuration(step.runMs)}</span>
    </li>
  );
}

/** 连着的同一种等待折成一行：等内存 N 次，共 X。 */
function WaitsRow({ item }: { item: Extract<TimelineItem, { kind: 'waits' }> }) {
  return (
    <li
      data-waits={item.waitFor}
      className="flex min-w-0 items-baseline gap-2 px-4 py-1 pl-10 text-meta text-muted-foreground max-md:pl-8"
      title={item.detail}
    >
      <span className="min-w-0 truncate">
        引擎：等{waitLabel(item.waitFor)} {item.count} 次，共 {formatDuration(item.totalMs)}
      </span>
    </li>
  );
}

/** 回合头：第几回合、结局、用时；返工回合写为什么返工。 */
function RoundHeader({
  g,
  roundsKnown,
  isLast,
}: {
  g: RoundGroup;
  /** 回合表读到了：没读到（老后端、读不了）时不判「进行中」，什么结局都不写。 */
  roundsKnown: boolean;
  isLast: boolean;
}) {
  if (g.seq === undefined) {
    // 对题在对话里做、不进回合：只有对题的一组不写「老记录没记回合」
    const onlyScope = g.items.every((i) => i.kind !== 'run' || i.run.segment === 'scope');
    if (onlyScope) {
      return (
        <div className="px-4 py-1.5" data-round-header="scope">
          <p className="text-body font-semibold text-muted-foreground">回合之前</p>
        </div>
      );
    }
    return (
      <div className="px-4 py-1.5" data-round-header="old">
        <p className="text-body font-semibold text-muted-foreground">更早的几笔</p>
        <p className="text-meta text-muted-foreground">老记录没记回合，不猜它们属于哪一回合。</p>
      </div>
    );
  }
  const out = g.round ? roundOutcome(g.round.outcome) : undefined;
  const dur = roundDurationMs(g);
  const prevOut = g.reworkOf ? roundOutcome(g.reworkOf.outcome) : undefined;
  const reworkWhy = g.reworkOf ? reworkDetail(g.reworkOf.outcome, g.reworkOf.summary) : undefined;
  return (
    <div className="px-4 py-1.5" data-round-header={g.seq}>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-body font-semibold">第 {g.seq} 回合</span>
        {g.reworkOf ? <span className="text-meta text-muted-foreground">返工</span> : null}
        {out ? (
          <StatusBadge tone={out.tone} label={out.label} />
        ) : !roundsKnown ? null : isLast ? (
          <StatusBadge tone="run" label="进行中" />
        ) : (
          <StatusBadge tone="doubt" label="结局没记" />
        )}
        {dur !== undefined ? (
          <span className="num text-meta text-muted-foreground">{formatDuration(dur)}</span>
        ) : null}
        {g.round?.tier ? <span className="text-meta text-muted-foreground">{g.round.tier}</span> : null}
        {g.round?.addedLines !== undefined ? (
          <span className="num text-meta text-muted-foreground">PR 新增 {g.round.addedLines} 行</span>
        ) : null}
      </p>
      {g.reworkOf ? (
        <p className="mt-0.5 text-meta text-muted-foreground" data-rework-why>
          为什么返工：上一回合{prevOut?.label ?? g.reworkOf.outcome}
          {reworkWhy ? `——${reworkWhy}` : '（没记返工意见）'}
        </p>
      ) : null}
      {g.byTime ? (
        <p className="mt-0.5 text-meta text-muted-foreground" data-round-bytime>
          其中 {g.byTime} 笔是旧引擎跑的、没记回合号，按回合收场时刻归进来
        </p>
      ) : null}
    </div>
  );
}

/** 顶上的时间条：每笔一段，宽度按用时比例；失败红、在跑蓝、其余灰；点一段跳到那一笔。 */
function RunBar({ runs, now }: { runs: readonly SegmentRunView[]; now: number }) {
  if (runs.length < 2) return null;
  const weights = barWeights(runs.map((r) => runDurationMs(r, now) ?? 0));
  return (
    <ul className="flex h-2 gap-px overflow-hidden rounded-full" aria-label="每一笔各占多久" data-run-bar>
      {runs.map((r, i) => {
        const failed = r.outcome !== undefined && segmentOutcomeTone[r.outcome] === 'fail';
        const label = `${r.segment ? segmentLabel[r.segment] : UNKNOWN_SEGMENT}第 ${runNth(runs, r.id) ?? 1} 次`;
        const dur = runDurationMs(r, now);
        return (
          <li key={r.id} className="flex min-w-1" style={{ flex: `${weights[i] ?? 1} 1 0` }}>
            <button
              type="button"
              onClick={() =>
                document.querySelector(`[data-run-process="${r.id}"]`)?.scrollIntoView({ block: 'nearest' })
              }
              title={`${label}：${dur === undefined ? '耗时没读到' : formatDuration(dur)}`}
              aria-label={`${label}，${dur === undefined ? '耗时没读到' : `用时 ${formatDuration(dur)}`}`}
              data-bar-run={r.id}
              className={cn(
                'w-full hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                failed ? 'bg-st-fail' : r.running ? 'bg-st-run' : 'bg-border-strong',
              )}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** 「过程」整块：时间条 + 回合 → 笔。 */
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
  const runs = d.segmentRuns;
  const tallyByRun = o?.tally.state === 'ok' ? o.tally.byRun : undefined;
  const timeline = buildTimeline(runs, o);
  const lastRunId = runs.at(-1)?.id;
  const notes: ReactNode[] = [];
  if (!o) {
    notes.push(
      <Notice key="old" tone="info">
        这台后端还没有「回合」「引擎做的事」这些项（老版本推来的详情），下面只有笔和它们的步骤。
      </Notice>,
    );
  } else {
    if (o.rounds.state === 'unavailable')
      notes.push(
        <Notice key="rounds" tone="stall" title="回合没读到">
          <span className="break-words">{o.rounds.reason}</span>
        </Notice>,
      );
    if (o.engineSteps.state === 'unavailable')
      notes.push(
        <Notice key="engine" tone="stall" title="引擎做的事没读到">
          <span className="break-words">{o.engineSteps.reason}</span>
        </Notice>,
      );
  }
  return (
    <Section
      title="过程"
      description="回合 → 笔 → 步骤 → 调用；有失败、在跑的自动展开"
      flush
      data-task-process
    >
      {runs.length === 0 ? (
        <EmptyState title="还没有过程" hint="三段跑起来以后，每一笔、每一步都记在这里。" />
      ) : (
        <>
          {notes.length > 0 ? <div className="space-y-2 p-4 pb-0">{notes}</div> : null}
          <div className="px-4 pt-3 pb-2">
            <RunBar runs={runs} now={now} />
          </div>
          <div className="divide-y">
            {timeline.map((g, i) => (
              <section key={g.key} aria-label={g.seq === undefined ? '更早的几笔' : `第 ${g.seq} 回合`}>
                <RoundHeader
                  g={g}
                  roundsKnown={o?.rounds.state === 'ok'}
                  isLast={i === timeline.length - 1}
                />
                <ol className="divide-y divide-border" data-round-items>
                  {g.items.map((it) =>
                    it.kind === 'run' ? (
                      <RunRow
                        key={it.key}
                        d={d}
                        run={it.run}
                        tally={tallyByRun?.[it.run.id]}
                        now={now}
                        startOpen={it.run.id === lastRunId}
                        onViewTranscript={onViewTranscript}
                      />
                    ) : it.kind === 'engine' ? (
                      <EngineRow key={it.key} step={it.step} />
                    ) : (
                      <WaitsRow key={it.key} item={it} />
                    ),
                  )}
                </ol>
              </section>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}
