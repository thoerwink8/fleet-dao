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
import { Check, ChevronRight, CircleDashed, LoaderCircle, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { STEP_CALLS_MAX, useRunProcess, useStepCalls } from '../api/client';
import type { ProcessStep, RunTally, TaskDetail, TranscriptEntry } from '../api/types';
import { formatClock, formatClockSeconds, formatDuration } from '../lib/format';
import {
  runNth,
  type SegmentRunView,
  segmentLabel,
  segmentOutcomeLabel,
  segmentOutcomeTone,
  UNKNOWN_SEGMENT,
} from '../lib/segments';
import { isTaskFinished } from '../lib/status';
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
  roundProgress,
  runDurationMs,
  runOrder,
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
import { inkClass } from './layout/tone';
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
        <span className="flex min-w-0 items-center gap-2">
          <StateIcon state={step.running ? 'running' : step.failed ? 'fail' : 'done'} />
          <span
            className={cn(
              'min-w-0 truncate text-body',
              title === null && 'text-muted-foreground',
              step.failed && 'text-ink-fail',
            )}
            title={title ?? UNTITLED_STEP}
            data-step-title
          >
            {title ?? UNTITLED_STEP}
          </span>
          <ChevronRight
            className={cn('ml-auto size-3.5 shrink-0 text-muted-foreground', open && 'rotate-90')}
            aria-hidden
          />
        </span>
        <span
          className={cn(
            'num flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 pl-6 text-meta',
            step.running ? 'text-ink-run' : 'text-muted-foreground',
          )}
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

type RowState = 'running' | 'fail' | 'done' | 'unknown';
const STATE_SAID: Record<RowState, string> = {
  running: '在跑',
  fail: '有失败',
  done: '完成',
  unknown: '结局没读到',
};

/** 行首的状态图标（照设计稿）：完成绿勾、没成红叉、在跑蓝圈转、读不到的灰虚圈；屏幕阅读器读字。 */
function StateIcon({ state, size = 'sm' }: { state: RowState; size?: 'sm' | 'md' }) {
  const cls = cn('shrink-0', size === 'md' ? 'size-4' : 'size-3.5');
  return (
    <>
      {state === 'running' ? (
        <LoaderCircle className={cn(cls, 'animate-spin text-ink-run')} aria-hidden />
      ) : state === 'fail' ? (
        <X className={cn(cls, 'text-ink-fail')} aria-hidden />
      ) : state === 'done' ? (
        <Check className={cn(cls, 'text-ink-done')} aria-hidden />
      ) : (
        <CircleDashed className={cn(cls, 'text-muted-foreground')} aria-hidden />
      )}
      <span className="sr-only">{STATE_SAID[state]}</span>
    </>
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

/**
 * 一笔（照设计稿）：状态图标 + 「第 N 笔 · 段 · 为什么起」+ 新会话还是接上；第二行模型、起止、用时、结局；
 * 再下面起因摘要、小计。右边展开箭头和「看会话」。展开是这一笔的步骤。
 */
function RunRow({
  d,
  run,
  nth,
  tally,
  now,
  startOpen,
  onViewTranscript,
}: {
  d: TaskDetail;
  run: SegmentRunView;
  /** 这一笔是整张单的第几笔（按起跑先后，三段一起数）。 */
  nth: number;
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
  const dur = runDurationMs(run, now);
  const state: RowState = run.running
    ? 'running'
    : !run.outcome
      ? 'unknown'
      : failedOutcome
        ? 'fail'
        : 'done';
  const tone = run.running ? 'run' : run.outcome ? segmentOutcomeTone[run.outcome] : 'stall';
  // 收场了、概览里没有这一笔的小计：库里一条记录都没有（跑在记录会话内容之前）；概览读不到小计时不下这个结论
  const noRecordKnown = d.overview?.tally.state === 'ok' && tally === undefined && !run.running;
  return (
    <li data-run-process={run.id} data-open={open ? '' : undefined} className="min-w-0">
      <div className="flex min-w-0 items-start gap-2 px-4 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setPicked(!open)}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-10"
        >
          <span className="mt-0.5 flex">
            <StateIcon state={state} size="md" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* 第一行：第几笔 · 段 · 为什么起，后面灰字新会话还是接上一笔 */}
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-body font-medium">
                <span className="num">第 {nth} 笔</span> · {label}
                {cause ? (
                  <>
                    {' · '}
                    <span
                      className={cause.recorded ? '' : 'font-normal text-muted-foreground'}
                      data-run-cause={run.cause ?? 'unrecorded'}
                    >
                      {cause.text}
                    </span>
                  </>
                ) : null}
              </span>
              {link ? (
                <span className="text-meta text-muted-foreground" data-run-link>
                  {link}
                </span>
              ) : null}
            </span>
            {/* 第二行：模型 · 起止 · 用时 · 结局（结局用语义色字） */}
            <span className="num flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-meta text-muted-foreground">
              <span className="min-w-0 truncate">{run.modelName}</span>
              {run.startedAt ? (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    {formatClock(run.startedAt)}–{run.endedAt ? formatClock(run.endedAt) : '现在'}
                  </span>
                </>
              ) : null}
              <span aria-hidden>·</span>
              <span>{dur !== undefined ? formatDuration(dur) : '耗时没读到'}</span>
              <span aria-hidden>·</span>
              <span className={cn('font-medium', inkClass[tone])} data-run-outcome>
                {run.running ? '在跑' : run.outcome ? segmentOutcomeLabel[run.outcome] : '结局没读到'}
              </span>
            </span>
            {run.causeSummary ? (
              <span
                className="min-w-0 truncate text-meta text-muted-foreground"
                title={run.causeSummary}
                data-run-cause-summary
              >
                {run.causeSummary}
              </span>
            ) : null}
            {tally ? <RunTallyLine tally={tally} running={run.running} /> : null}
          </span>
          <ChevronRight
            className={cn('mt-1 size-4 shrink-0 text-muted-foreground', open && 'rotate-90')}
            aria-hidden
          />
        </button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          onClick={() => onViewTranscript(run.id)}
        >
          看会话
        </Button>
      </div>
      {open ? <RunBody d={d} run={run} now={now} noRecordKnown={noRecordKnown} /> : null}
    </li>
  );
}

type EngineItem = Extract<TimelineItem, { kind: 'engine' | 'waits' }>;

/** 引擎做的一件事：「自测」「推分支」……没成的红字写没成和错误码；连着的同一种等待写「等内存 N 次，共 X」。 */
function EnginePiece({ item }: { item: EngineItem }) {
  if (item.kind === 'waits') {
    return (
      <span data-waits={item.waitFor} title={item.detail}>
        等{waitLabel(item.waitFor)} {item.count} 次，共 {formatDuration(item.totalMs)}
      </span>
    );
  }
  const step = item.step;
  const failed = step.outcome !== 'ok';
  return (
    <span
      data-engine={step.activity}
      data-failed={failed ? '' : undefined}
      title={`${formatClockSeconds(step.startedAt)} 起，用时 ${formatDuration(step.runMs)}`}
      className={failed ? 'font-medium text-ink-fail' : 'text-foreground'}
    >
      {ACTIVITY_LABEL[step.activity] ?? step.activity}
      {step.attempt > 1 ? `（第 ${step.attempt} 次）` : ''}
      {failed
        ? step.outcome === 'cancelled'
          ? ' 被取消'
          : ` 没成${step.errorCode ? `：${step.errorCode}` : ''}`
        : ''}
    </span>
  );
}

/**
 * 笔之间引擎在会话外连着做的几件事串成一行（照设计稿）：「引擎 自测 → 推分支 → 开 PR → 等 CI 没成」，
 * 右边是这几件加起来的用时；每件的起始时刻和用时在悬停里。
 */
function EngineChain({ items }: { items: readonly EngineItem[] }) {
  const total = items.reduce((n, it) => n + (it.kind === 'waits' ? it.totalMs : it.step.runMs), 0);
  return (
    <li
      data-engine-chain
      className="flex min-w-0 items-baseline gap-2 bg-muted px-4 py-1.5 text-meta text-muted-foreground"
    >
      <span className="shrink-0">引擎</span>
      <span className="min-w-0 flex-1 break-words">
        {items.map((it, i) => (
          <span key={it.key}>
            {i > 0 ? <span aria-hidden> → </span> : null}
            <EnginePiece item={it} />
          </span>
        ))}
      </span>
      <span className="num shrink-0">{formatDuration(total)}</span>
    </li>
  );
}

/** 一个回合里的东西排成「笔」和「连着的一串引擎活动」两种行。 */
function chainItems(
  items: readonly TimelineItem[],
): (
  | { kind: 'run'; item: Extract<TimelineItem, { kind: 'run' }> }
  | { kind: 'chain'; key: string; items: EngineItem[] }
)[] {
  const out: ReturnType<typeof chainItems> = [];
  for (const it of items) {
    if (it.kind === 'run') {
      out.push({ kind: 'run', item: it });
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === 'chain') last.items.push(it);
    else out.push({ kind: 'chain', key: `chain-${it.key}`, items: [it] });
  }
  return out;
}

/**
 * 回合头（照设计稿）：第几回合、起止、用时、几笔，结局用语义色字放右边，点了收起 / 展开；
 * 返工回合下面一个淡红框写为什么返工。
 */
function RoundHeader({
  g,
  roundsKnown,
  isLast,
  open,
  onToggle,
}: {
  g: RoundGroup;
  /** 回合表读到了：没读到（老后端、读不了）时不判「进行中」，什么结局都不写。 */
  roundsKnown: boolean;
  isLast: boolean;
  /** 回合收没收起（「回合之前」「更早的几笔」两组不收）。 */
  open: boolean;
  onToggle: () => void;
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
  const runs = g.items.filter((i) => i.kind === 'run');
  const firstRun = runs[0];
  const start = g.round?.startedAt ?? (firstRun?.kind === 'run' ? firstRun.run.startedAt : undefined);
  // 结局放右边，用语义色字（照设计稿），不用徽章
  const verdict = out
    ? { text: out.label, tone: out.tone }
    : !roundsKnown
      ? undefined
      : isLast
        ? { text: '进行中', tone: 'run' as const }
        : { text: '结局没记', tone: 'doubt' as const };
  return (
    <div className="px-4 pt-3 pb-1.5" data-round-header={g.seq}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-x-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-10"
      >
        <span className="shrink-0 text-body font-semibold">第 {g.seq} 回合</span>
        {g.reworkOf ? <span className="shrink-0 text-meta text-muted-foreground">返工</span> : null}
        <span className="num min-w-0 truncate text-meta text-muted-foreground">
          {[
            start
              ? `${formatClock(start)}${g.round ? `–${formatClock(g.round.endedAt)}` : ' 起'}`
              : undefined,
            dur !== undefined ? formatDuration(dur) : undefined,
            runs.length ? `${runs.length} 笔` : undefined,
            g.round?.tier,
            g.round?.addedLines !== undefined ? `PR 新增 ${g.round.addedLines} 行` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {verdict ? (
          <span className={cn('ml-auto shrink-0 text-meta font-medium', inkClass[verdict.tone])}>
            {verdict.text}
          </span>
        ) : null}
        <ChevronRight
          className={cn('size-4 shrink-0 text-muted-foreground', !verdict && 'ml-auto', open && 'rotate-90')}
          aria-hidden
        />
      </button>
      {g.reworkOf ? (
        <p
          className="mt-2 rounded-md border border-st-fail-line bg-st-fail-soft px-3 py-2 text-meta"
          data-rework-why
        >
          <span className="font-medium text-ink-fail">为什么返工</span>
          <span className="text-muted-foreground">
            {'　'}上一回合{prevOut?.label ?? g.reworkOf.outcome}
            {reworkWhy ? `——${reworkWhy}` : '（没记返工意见）'}
          </span>
        </p>
      ) : null}
      {g.byTime ? (
        <p className="mt-1 text-meta text-muted-foreground" data-round-bytime>
          其中 {g.byTime} 笔是旧引擎跑的、没记回合号，按回合收场时刻归进来
        </p>
      ) : null}
    </div>
  );
}

/** 顶上的时间条：每笔一段，宽度按用时比例；失败红、在跑蓝、其余灰；点一段跳到那一笔。 */
function RunBar({
  runs,
  now,
  onPick,
}: {
  runs: readonly SegmentRunView[];
  now: number;
  /** 点一段：展开那一笔所在的回合，再滚到它。 */
  onPick: (runId: string) => void;
}) {
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
              onClick={() => onPick(r.id)}
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

/** 时间条下面一行起止：最早一笔起跑的时刻，到最后一笔收场（单子结束了）或「现在」。 */
function BarAxis({
  runs,
  now,
  finished,
}: {
  runs: readonly SegmentRunView[];
  now: number;
  finished: boolean;
}) {
  const starts = runs.flatMap((r) => (r.startedAt ? [r.startedAt] : [])).sort();
  const ends = runs.flatMap((r) => (r.endedAt ? [r.endedAt] : [])).sort();
  const first = starts[0];
  if (!first) return null;
  const last = ends.at(-1);
  return (
    <div className="num mt-1 flex text-meta text-muted-foreground" data-bar-axis>
      <span>{formatClock(first)}</span>
      <span className="ml-auto">
        {finished ? (last ? formatClock(last) : '') : `现在 ${formatClock(new Date(now).toISOString())}`}
      </span>
    </div>
  );
}

/** 面板头、正文末尾那一行（#3277）：和过程头上同一句。 */
export function processSummaryOf(d: TaskDetail, now: number): string {
  const rounds = buildTimeline(d.segmentRuns, d.overview).filter((g) => g.seq !== undefined).length;
  return processSummary(d.segmentRuns, rounds, now, isTaskFinished(d.task));
}

/** 头上一句：几个回合 · 几笔 · 用时（最早一笔起跑到最后收场或现在）。 */
function processSummary(
  runs: readonly SegmentRunView[],
  rounds: number,
  now: number,
  finished: boolean,
): string {
  const starts = runs.flatMap((r) => (r.startedAt ? [Date.parse(r.startedAt)] : []));
  const ends = runs.flatMap((r) => (r.endedAt ? [Date.parse(r.endedAt)] : []));
  const parts = [rounds ? `${rounds} 个回合` : undefined, `${runs.length} 笔`];
  if (starts.length) {
    const end = finished ? Math.max(...ends) : now;
    if (Number.isFinite(end)) parts.push(`用时 ${formatDuration(Math.max(0, end - Math.min(...starts)))}`);
  }
  return parts.filter(Boolean).join(' · ');
}

/** 「过程」整块（照设计稿）：头上一句、时间条和起止，回合 → 笔（笔之间引擎的事串成一行），进行中的回合末尾写接下来。 */
export function TaskProcess({
  d,
  now,
  onViewTranscript,
  inPanel = false,
}: {
  d: TaskDetail;
  now: number;
  onViewTranscript: (runId: string) => void;
  /** 放在任务页右侧面板里（#3277）：标题和那一句在面板头上，这里不再画标题、不再套卡片。 */
  inPanel?: boolean;
}) {
  const o = d.overview;
  const runs = d.segmentRuns;
  const tallyByRun = o?.tally.state === 'ok' ? o.tally.byRun : undefined;
  const timeline = buildTimeline(runs, o);
  const lastRunId = runs.at(-1)?.id;
  const finished = isTaskFinished(d.task);
  // 第几笔：整张单按起跑先后一起数（三段不分开），和设计稿的「第 N 笔」一致
  const nthOf = runOrder(runs);
  // 回合默认只展开最后一个和有笔在跑的，前面收场了的收成一行头；人点过就听人的
  const [roundPicks, setRoundPicks] = useState<Record<string, boolean>>({});
  const roundOpen = (g: RoundGroup, i: number) =>
    g.seq === undefined ||
    (roundPicks[g.key] ??
      (i === timeline.length - 1 || g.items.some((it) => it.kind === 'run' && it.run.running)));
  const roundsCount = timeline.filter((g) => g.seq !== undefined).length;
  // 进行中的单：最后一回合末尾写「接下来」还要走的几步；返工、下一回合还没开跑的写下一回合整条
  const progress = finished ? undefined : roundProgress(timeline, d.task.state);
  const lastSeq = timeline.at(-1)?.seq;
  const next =
    progress === undefined
      ? undefined
      : progress.seq === lastSeq
        ? progress.stages.filter((s) => s.state === 'todo').map((s) => s.label)
        : progress.stages.map((s) => s.label);
  const nextText =
    next && next.length > 0
      ? `${progress && progress.seq !== lastSeq ? `第 ${progress.seq} 回合：` : ''}${next.join(' → ')}`
      : undefined;
  const jumpTo = (runId: string) => {
    const g = timeline.find((x) => x.items.some((it) => it.kind === 'run' && it.run.id === runId));
    if (g && g.seq !== undefined) setRoundPicks((p) => ({ ...p, [g.key]: true }));
    requestAnimationFrame(() =>
      document.querySelector(`[data-run-process="${runId}"]`)?.scrollIntoView({ block: 'nearest' }),
    );
  };
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
      title={inPanel ? undefined : '过程'}
      description={!inPanel && runs.length ? processSummary(runs, roundsCount, now, finished) : undefined}
      variant={inPanel ? 'plain' : 'card'}
      flush
      data-task-process
    >
      {runs.length === 0 ? (
        <EmptyState title="还没有过程" hint="三段跑起来以后，每一笔、每一步都记在这里。" />
      ) : (
        <>
          {notes.length > 0 ? <div className="space-y-2 p-4 pb-0">{notes}</div> : null}
          <div className="px-4 pt-3 pb-1">
            <RunBar runs={runs} now={now} onPick={jumpTo} />
            <BarAxis runs={runs} now={now} finished={finished} />
          </div>
          <div className="divide-y">
            {timeline.map((g, i) => {
              const open = roundOpen(g, i);
              const isLast = i === timeline.length - 1;
              return (
                <section key={g.key} aria-label={g.seq === undefined ? '更早的几笔' : `第 ${g.seq} 回合`}>
                  <RoundHeader
                    g={g}
                    roundsKnown={o?.rounds.state === 'ok'}
                    isLast={isLast}
                    open={open}
                    onToggle={() => setRoundPicks((p) => ({ ...p, [g.key]: !open }))}
                  />
                  {open ? (
                    <ol className="divide-y divide-border" data-round-items>
                      {chainItems(g.items).map((row) =>
                        row.kind === 'run' ? (
                          <RunRow
                            key={row.item.key}
                            d={d}
                            run={row.item.run}
                            nth={nthOf.get(row.item.run.id) ?? 1}
                            tally={tallyByRun?.[row.item.run.id]}
                            now={now}
                            startOpen={row.item.run.id === lastRunId}
                            onViewTranscript={onViewTranscript}
                          />
                        ) : (
                          <EngineChain key={row.key} items={row.items} />
                        ),
                      )}
                      {isLast && nextText ? (
                        <li
                          data-next-steps
                          className="flex min-w-0 items-baseline gap-2 px-4 py-2 text-meta text-muted-foreground"
                        >
                          <span className="shrink-0">接下来</span>
                          <span className="min-w-0 break-words">{nextText}</span>
                        </li>
                      ) : null}
                    </ol>
                  ) : null}
                </section>
              );
            })}
          </div>
        </>
      )}
    </Section>
  );
}
