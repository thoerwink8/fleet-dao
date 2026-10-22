// 任务页「过程」（#3140，#3533 照 Arco 重拼）：回合 → 笔 → 步骤 → 调用 四层，照引擎实际走法排。
// 什么都先收成一行，细节靠点开；颜色只给异常（失败红、超时红、读不到橙），其余黑白灰。
// - 回合：一次「动手 → 自测 → 推分支 → CI → 验收」（task_rounds）。返工回合顶上写为什么返工；老记录没记回合的单列一组。
// - 笔：一次起会话（runs 的一行）。写为什么起、新会话还是接上一笔的会话、结局、用时、小计；笔之间写引擎在会话外做的事
//   （自测、推分支、开 PR、等 CI、验收、合并），连着的等待折成一行。
// - 步骤：Agent 说的一句话 + 它接着做的那串调用（切法在 shared 的 task-process.ts，后端按笔现算，展开这一笔才去读）。
//   步骤行：标题、起止时刻、用时、小计；有失败的、在跑的默认展开，人点过一次就听人的。
// - 调用：展开一步才去读这一步的序号区间。
// - 顶上一条时间条，看每笔各占多久。
// 读不到的写「没读到」和原因：老后端没给 overview、哪一块读不了、这一笔跑在记录之前，都分开写，不画 0。
// 读成过、这次刷新没成：照画上一次的，顶上一条橙提示加重试（lib/query-view.ts）。
// 页面只拼 components/layout 的件，不写样式（design 第三节）。
import { type ReactNode, useState } from 'react';
import { STEP_CALLS_MAX, useRunProcess, useStepCalls } from '../api/client';
import type { ProcessStep, RunTally, TaskDetail } from '../api/types';
import { formatClock, formatClockSeconds, formatDuration, TIME } from '../lib/format';
import { viewOf } from '../lib/query-view';
import {
  runNth,
  type SegmentRunView,
  segmentLabel,
  segmentOutcomeTone,
  UNKNOWN_SEGMENT,
} from '../lib/segments';
import { isTaskFinished } from '../lib/status';
import {
  ACTIVITY_LABEL,
  barWeights,
  buildTimeline,
  causeLabel,
  type RoundGroup,
  reworkDetail,
  roundDurationMs,
  roundOutcome,
  roundProgress,
  roundStatusKey,
  runDurationMs,
  runOrder,
  sessionLink,
  stepDurationMs,
  type TimelineItem,
  UNTITLED_STEP,
  uncountedHint,
  waitLabel,
} from '../lib/task-process';
import { groupEntries } from '../lib/transcript-items';
import { toStatus } from '../theme/status-dict';
import { CallRow } from './call-row';
import { DiffStat } from './diff-stat';
import { Band } from './layout/band';
import { Button } from './layout/button';
import { Disclosure, DisclosureRow } from './layout/disclosure';
import { EmptyState } from './layout/empty-state';
import { List, RowDetail } from './layout/list';
import { LoadError, LoadingRows, LoadStale } from './layout/load-state';
import { MetaLine } from './layout/meta-line';
import { Nest } from './layout/nest';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Tag } from './layout/tag';
import { Text } from './layout/text';
import { TimeBar } from './layout/time-bar';

export { DiffStat };

/** 读成过、这次刷新没成的旧数据多久算过期：过程里的步骤、调用在跑时每 3 秒读一次，超过 5 分钟没读成就标「数据已过期」。 */
const STALE_AFTER_MS = 5 * TIME.MIN;

/** 子代理的东西缩进一级，主会话的不缩。 */
function indented(key: number, sub: boolean, node: ReactNode): ReactNode {
  return sub ? <Nest key={key}>{node}</Nest> : <div key={key}>{node}</div>;
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
  const view = viewOf(q);
  if (view.status === 'loading') {
    return (
      <div role="status">
        <LoadingRows rows={2} />
        <Text size="meta" tone="muted">
          正在读这一步的调用…
        </Text>
      </div>
    );
  }
  if (view.status === 'error') {
    return <LoadError what="这一步的调用" error={view.error} onRetry={view.retry} />;
  }
  const entries = view.data.entries.filter((e) => e.seq >= step.firstSeq && e.seq <= step.lastSeq);
  const items = groupEntries(entries);
  const total = step.lastSeq - step.firstSeq + 1;
  return (
    <Stack gap="sm">
      {view.stale ? <LoadStale what="这一步的调用" stale={view.stale} staleAfterMs={STALE_AFTER_MS} /> : null}
      <div data-step-calls>
        <Stack gap="sm">
          {items.map((item) => {
            if (item.kind === 'call') {
              return indented(
                item.call.seq,
                item.call.meta?.subagent !== undefined,
                <CallRow call={item.call} result={item.result} live={live} />,
              );
            }
            const e = item.entry;
            if (e.kind === 'assistant') {
              // 这一步的标题就是第一句话，不重复；后面补的话、子代理说的话灰字露出来
              if (title !== null && e.text.trim().startsWith(title.replace(/…$/, '').slice(0, 20)))
                return null;
              return indented(
                e.seq,
                e.meta?.subagent !== undefined,
                <Text as="p" size="meta" tone="muted" pre lines={3}>
                  {e.text}
                </Text>,
              );
            }
            if (e.kind === 'error') {
              return (
                <div key={e.seq} role="alert">
                  <Text as="p" tone="danger" pre>
                    <Text tone="danger" strong>
                      报错{' '}
                    </Text>
                    {e.text}
                  </Text>
                </div>
              );
            }
            if (e.kind === 'result') {
              return (
                <Text key={e.seq} as="p" strong tone={e.ok === false ? 'danger' : 'default'} pre>
                  结论：{e.text}
                </Text>
              );
            }
            return null;
          })}
          {total > STEP_CALLS_MAX && view.data.entries.length >= STEP_CALLS_MAX ? (
            <Text size="meta" tone="muted">
              这一步一共 {total} 条，这里只读了前 {STEP_CALLS_MAX} 条，全部在「看会话」里。
            </Text>
          ) : null}
        </Stack>
      </div>
    </Stack>
  );
}

const UNKNOWN_HINT = '命令没有结果：老记录对不上、笔收场了没记下、这一家的流里没有退出码';
const NO_LINES_HINT = '这几次编辑没有记行数';

/** 一步的小计，给一行灰字（MetaLine）用：调用数、命令数、失败数（红）、结果未知、读了几次文件、改了几个文件 +/-。 */
export function stepTallyItems(step: ProcessStep): ReactNode[] {
  const parts: ReactNode[] = [];
  if (step.calls > 0) parts.push(<span key="calls">{step.calls} 个调用</span>);
  if (step.commands > 0) parts.push(<span key="cmd">{step.commands} 个命令</span>);
  if (step.callsFailed > 0)
    parts.push(
      <span key="fail" data-step-failed-count>
        <Text size="meta" tone="danger" strong>
          {step.callsFailed} 个失败
        </Text>
      </span>,
    );
  if (step.commandsUnknown > 0)
    parts.push(
      <span key="unk" title={UNKNOWN_HINT}>
        {step.commandsUnknown} 个结果未知
      </span>,
    );
  if (step.reads > 0) parts.push(<span key="read">读 {step.reads} 次文件</span>);
  if (step.files.length > 0) {
    const anyCounted = step.files.some((f) => f.added !== undefined || f.removed !== undefined);
    parts.push(
      <Stack key="files" direction="horizontal" gap="sm" align="baseline">
        <span>改 {step.files.length} 个文件</span>
        {anyCounted ? (
          <DiffStat added={step.added} removed={step.removed} title={uncountedHint(step.uncounted)} />
        ) : (
          <span title={NO_LINES_HINT}>没记行数</span>
        )}
      </Stack>,
    );
  }
  return parts;
}

/** 这一笔里要默认展开的步骤：有失败的、在跑的。 */
export function defaultOpenSteps(steps: readonly ProcessStep[]): Set<number> {
  return new Set(steps.filter((s) => s.failed || s.running).map((s) => s.index));
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
    >
      <Disclosure
        size="compact"
        open={open}
        onToggle={onToggle}
        trailing={
          step.running ? (
            <StatusBadge status="task:segment:running" variant="dot" />
          ) : step.failed ? (
            <Tag tone="error">有失败</Tag>
          ) : undefined
        }
        header={
          <>
            <span data-step-title>
              <Text
                truncate
                tone={step.failed ? 'danger' : title === null ? 'muted' : 'default'}
                title={title ?? UNTITLED_STEP}
              >
                {title ?? UNTITLED_STEP}
              </Text>
            </span>
            <span data-step-meta>
              <MetaLine
                items={[
                  <span key="time" data-step-time>
                    {formatClockSeconds(step.startedAt)}–
                    {step.endedAt ? formatClockSeconds(step.endedAt) : '现在'}
                  </span>,
                  <span key="dur" data-step-duration>
                    用时 {formatDuration(dur)}
                  </span>,
                  ...(hasTally ? stepTallyItems(step) : []),
                ]}
              />
            </span>
          </>
        }
      >
        <StepCalls taskId={taskId} runId={runId} step={step} live={live} title={title} />
      </Disclosure>
    </li>
  );
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
    <div data-step-bar>
      <TimeBar
        label="每一步各占多久"
        onPick={(id) => onPick(Number(id))}
        items={steps.map((s, i) => {
          const name = s.title ?? UNTITLED_STEP;
          const dur = formatDuration(stepDurationMs(s, now));
          return {
            id: String(s.index),
            weight: weights[i] ?? 1,
            state: s.failed ? 'fail' : s.running ? 'run' : 'idle',
            label: `第 ${s.index + 1} 步：${name}，用时 ${dur}`,
            title: `${name}：${dur}`,
          };
        })}
      />
    </div>
  );
}

/** 笔头一行的小计：命令几个、失败几个、改了几次文件 +/-；读不到小计的整行不写（概览顶上已写了原因）。 */
function runTallyItems(tally: RunTally, running: boolean): ReactNode[] {
  const anyCounted = tally.added > 0 || tally.removed > 0;
  const bits: ReactNode[] = [];
  if (tally.commands > 0) bits.push(<span key="cmd">{tally.commands} 个命令</span>);
  if (tally.commandsFailed > 0)
    bits.push(
      <Text key="fail" size="meta" tone="danger" strong>
        {tally.commandsFailed} 个失败
      </Text>,
    );
  if (tally.commandsRunning > 0 && running) bits.push(<span key="run">{tally.commandsRunning} 个在跑</span>);
  if (tally.commandsUnknown > 0)
    bits.push(
      <span key="unk" title={UNKNOWN_HINT}>
        {tally.commandsUnknown} 个结果未知
      </span>,
    );
  if (tally.editsOk > 0)
    bits.push(
      <Stack key="edit" direction="horizontal" gap="sm" align="baseline">
        <span>改 {tally.editsOk} 次</span>
        {anyCounted ? (
          <DiffStat added={tally.added} removed={tally.removed} title={uncountedHint(tally.uncounted)} />
        ) : (
          <span title={NO_LINES_HINT}>没记行数</span>
        )}
      </Stack>,
    );
  return bits;
}

/** 验收那一笔的结论：过没过、没过的问题、转给人的。 */
function Verdict({ verdict }: { verdict: NonNullable<SegmentRunView['verdict']> }) {
  return (
    <div data-verdict>
      <Stack gap="sm">
        <Text as="p" strong tone={verdict.pass ? 'default' : 'danger'}>
          {verdict.pass ? '验收通过' : '验收没过'}
          {verdict.failedCriteria.length > 0 ? `（第 ${verdict.failedCriteria.join('、')} 条）` : ''}
        </Text>
        {verdict.problems.length > 0 ? (
          <List divided={false}>
            {verdict.problems.map((p) => (
              <li key={p}>
                <Text size="meta" tone="secondary" pre>
                  {p}
                </Text>
              </li>
            ))}
          </List>
        ) : null}
        {verdict.handedOver.length > 0 ? (
          <Text as="p" size="meta" tone="secondary">
            转给人：{verdict.handedOver.join('；')}
          </Text>
        ) : null}
      </Stack>
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
  const view = viewOf(q);
  const body = (() => {
    if (noRecordKnown || (view.status === 'data' && view.data.state === 'noRecord')) {
      return (
        <div data-no-record>
          <Text as="p" tone="muted">
            这一笔跑在记录会话内容之前，没有过程记录
          </Text>
        </div>
      );
    }
    if (view.status === 'loading') {
      return (
        <div role="status">
          <LoadingRows rows={2} />
          <Text size="meta" tone="muted">
            正在读这一笔的步骤…
          </Text>
        </div>
      );
    }
    if (view.status === 'error') {
      return <LoadError what="这一笔的步骤" error={view.error} onRetry={view.retry} />;
    }
    if (view.data.state !== 'ok') return null;
    const proc = view.data.process;
    const auto = defaultOpenSteps(proc.steps);
    const stepOpen = (i: number) => stepPicks[i] ?? auto.has(i);
    if (proc.steps.length === 0) {
      return (
        <Text as="p" tone="muted">
          {run.running ? '会话刚起来，还没有内容。' : '这一笔没有可分步的内容（只有提示词）。'}
        </Text>
      );
    }
    return (
      <Stack gap="sm">
        {view.stale ? (
          <LoadStale what="这一笔的步骤" stale={view.stale} staleAfterMs={STALE_AFTER_MS} />
        ) : null}
        {proc.legacyCalls > 0 ? (
          <div data-legacy-note>
            <Text as="p" size="meta" tone="muted">
              老记录有 {proc.legacyCalls} 个调用没有调用号，对不上结果，命令成败写「结果未知」。
            </Text>
          </div>
        ) : null}
        <StepBar
          steps={proc.steps}
          now={now}
          onPick={(i) => {
            setStepPicks((p) => ({ ...p, [i]: true }));
            document.getElementById(`step-${run.id}-${i}`)?.scrollIntoView({ block: 'nearest' });
          }}
        />
        <List aria-label="步骤">
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
        </List>
        {proc.truncated ? (
          <Text as="p" size="meta" tone="muted">
            这一笔到了每段 3000 条的记录上限，后面的没记。
          </Text>
        ) : null}
      </Stack>
    );
  })();
  return (
    <div data-run-body>
      <Stack gap="sm">
        {run.verdict ? <Verdict verdict={run.verdict} /> : null}
        {body}
      </Stack>
    </div>
  );
}

/** 一笔的结局：字典里的词（完成、超时、被停掉……）；在跑、结局没读到另有词。 */
function runOutcomeStatus(run: SegmentRunView) {
  if (run.running) return 'task:segment:running' as const;
  if (!run.outcome) return 'task:segment:unread' as const;
  return toStatus('task', `segment:${run.outcome}`);
}

/**
 * 一笔（照设计稿）：「第 N 笔 · 段 · 为什么起」+ 新会话还是接上；第二行模型、起止、用时、结局；
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
  // 收场了、概览里没有这一笔的小计：库里一条记录都没有（跑在记录会话内容之前）；概览读不到小计时不下这个结论
  const noRecordKnown = d.overview?.tally.state === 'ok' && tally === undefined && !run.running;
  const tallyBits = tally ? runTallyItems(tally, run.running) : [];
  return (
    <li data-run-process={run.id} data-open={open ? '' : undefined}>
      <Disclosure
        open={open}
        onToggle={() => setPicked(!open)}
        actions={
          <Button variant="text" size="xs" onClick={() => onViewTranscript(run.id)}>
            看会话
          </Button>
        }
        header={
          <>
            {/* 第一行：第几笔 · 段 · 为什么起，后面灰字新会话还是接上一笔 */}
            <Stack direction="horizontal" gap="sm" align="baseline" wrap>
              <Text strong>
                第 {nth} 笔 · {label}
                {cause ? (
                  <>
                    {' · '}
                    <span data-run-cause={run.cause ?? 'unrecorded'}>
                      <Text strong={cause.recorded} tone={cause.recorded ? 'default' : 'muted'}>
                        {cause.text}
                      </Text>
                    </span>
                  </>
                ) : null}
              </Text>
              {link ? (
                <span data-run-link>
                  <Text size="meta" tone="muted">
                    {link}
                  </Text>
                </span>
              ) : null}
            </Stack>
            {/* 第二行：模型 · 起止 · 用时 · 结局 */}
            <MetaLine
              items={[
                run.modelName,
                run.startedAt
                  ? `${formatClock(run.startedAt)}–${run.endedAt ? formatClock(run.endedAt) : '现在'}`
                  : undefined,
                dur !== undefined ? formatDuration(dur) : '耗时没读到',
                <span key="outcome" data-run-outcome>
                  <StatusBadge status={runOutcomeStatus(run)} variant="dot" />
                </span>,
              ]}
            />
            {run.causeSummary ? (
              <span data-run-cause-summary>
                <Text size="meta" tone="muted" truncate title={run.causeSummary}>
                  {run.causeSummary}
                </Text>
              </span>
            ) : null}
            {tallyBits.length > 0 ? (
              <span data-run-tally>
                <MetaLine items={tallyBits} />
              </span>
            ) : null}
          </>
        }
      >
        <RunBody d={d} run={run} now={now} noRecordKnown={noRecordKnown} />
      </Disclosure>
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
  const text = `${ACTIVITY_LABEL[step.activity] ?? step.activity}${step.attempt > 1 ? `（第 ${step.attempt} 次）` : ''}${
    failed
      ? step.outcome === 'cancelled'
        ? ' 被取消'
        : ` 没成${step.errorCode ? `：${step.errorCode}` : ''}`
      : ''
  }`;
  return (
    <span
      data-engine={step.activity}
      data-failed={failed ? '' : undefined}
      title={`${formatClockSeconds(step.startedAt)} 起，用时 ${formatDuration(step.runMs)}`}
    >
      {failed ? (
        <Text size="meta" tone="danger" strong>
          {text}
        </Text>
      ) : (
        text
      )}
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
    <li data-engine-chain>
      <Band>
        <Stack direction="horizontal" gap="sm" align="baseline" justify="between">
          <Stack direction="horizontal" gap="sm" align="baseline">
            <Text size="meta" tone="muted">
              引擎
            </Text>
            <span>
              {items.map((it, i) => (
                <span key={it.key}>
                  {i > 0 ? <span aria-hidden> → </span> : null}
                  <EnginePiece item={it} />
                </span>
              ))}
            </span>
          </Stack>
          <span>{formatDuration(total)}</span>
        </Stack>
      </Band>
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

/** 回合头右边的结局：字典里的词；引擎多出来的新收场名认不出，原样写成橙标签，不猜。 */
function RoundVerdict({ g, roundsKnown, isLast }: { g: RoundGroup; roundsKnown: boolean; isLast: boolean }) {
  if (g.round) {
    const key = roundStatusKey(g.round.outcome);
    return key ? (
      <StatusBadge status={key} />
    ) : (
      <Tag tone="warning">{roundOutcome(g.round.outcome).label}</Tag>
    );
  }
  // 回合表没读到（老后端、读不了）：不判「进行中」，什么结局都不写
  if (!roundsKnown) return null;
  return <StatusBadge status={isLast ? 'task:round:open' : 'task:round:unrecorded'} />;
}

/**
 * 回合头（照设计稿）：第几回合、起止、用时、几笔，结局放右边，点了收起 / 展开；
 * 返工回合下面一条淡红色带写为什么返工。
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
        <RowDetail indent={false} data-round-header="scope">
          <Text as="p" strong tone="muted">
            回合之前
          </Text>
        </RowDetail>
      );
    }
    return (
      <RowDetail indent={false} data-round-header="old">
        <Text as="p" strong tone="muted">
          更早的几笔
        </Text>
        <Text as="p" size="meta" tone="muted">
          老记录没记回合，不猜它们属于哪一回合。
        </Text>
      </RowDetail>
    );
  }
  const dur = roundDurationMs(g);
  const prevOut = g.reworkOf ? roundOutcome(g.reworkOf.outcome) : undefined;
  const reworkWhy = g.reworkOf ? reworkDetail(g.reworkOf.outcome, g.reworkOf.summary) : undefined;
  const runs = g.items.filter((i) => i.kind === 'run');
  const firstRun = runs[0];
  const start = g.round?.startedAt ?? (firstRun?.kind === 'run' ? firstRun.run.startedAt : undefined);
  const facts = [
    start ? `${formatClock(start)}${g.round ? `–${formatClock(g.round.endedAt)}` : ' 起'}` : undefined,
    dur !== undefined ? formatDuration(dur) : undefined,
    runs.length ? `${runs.length} 笔` : undefined,
    g.round?.tier,
    g.round?.addedLines !== undefined ? `PR 新增 ${g.round.addedLines} 行` : undefined,
  ].filter(Boolean);
  return (
    <div data-round-header={g.seq}>
      <DisclosureRow
        open={open}
        onToggle={onToggle}
        trailing={<RoundVerdict g={g} roundsKnown={roundsKnown} isLast={isLast} />}
        header={
          <Stack direction="horizontal" gap="sm" align="baseline" wrap>
            <Text strong>第 {g.seq} 回合</Text>
            {g.reworkOf ? (
              <Text size="meta" tone="muted">
                返工
              </Text>
            ) : null}
            <Text size="meta" tone="muted">
              {facts.join(' · ')}
            </Text>
          </Stack>
        }
      />
      {g.reworkOf ? (
        <RowDetail indent={false}>
          <Band tone="danger" data-rework-why>
            <Text size="meta" tone="danger" strong>
              为什么返工
            </Text>{' '}
            <Text size="meta" tone="secondary">
              上一回合{prevOut?.label ?? g.reworkOf.outcome}
              {reworkWhy ? `——${reworkWhy}` : '（没记返工意见）'}
            </Text>
          </Band>
        </RowDetail>
      ) : null}
      {g.byTime ? (
        <RowDetail indent={false} data-round-bytime>
          <Text as="p" size="meta" tone="muted">
            其中 {g.byTime} 笔是旧引擎跑的、没记回合号，按回合收场时刻归进来
          </Text>
        </RowDetail>
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
    <div data-run-bar>
      <TimeBar
        label="每一笔各占多久"
        onPick={onPick}
        items={runs.map((r, i) => {
          const failed = r.outcome !== undefined && segmentOutcomeTone[r.outcome] === 'fail';
          const name = `${r.segment ? segmentLabel[r.segment] : UNKNOWN_SEGMENT}第 ${runNth(runs, r.id) ?? 1} 次`;
          const dur = runDurationMs(r, now);
          return {
            id: r.id,
            weight: weights[i] ?? 1,
            state: failed ? 'fail' : r.running ? 'run' : 'idle',
            label: `${name}，${dur === undefined ? '耗时没读到' : `用时 ${formatDuration(dur)}`}`,
            title: `${name}：${dur === undefined ? '耗时没读到' : formatDuration(dur)}`,
          };
        })}
      />
    </div>
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
    <div data-bar-axis>
      <Stack direction="horizontal" justify="between">
        <Text size="meta" tone="muted">
          {formatClock(first)}
        </Text>
        <Text size="meta" tone="muted">
          {finished ? (last ? formatClock(last) : '') : `现在 ${formatClock(new Date(now).toISOString())}`}
        </Text>
      </Stack>
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
  /** 放在面板或页签里（#3277）：标题和那一句在外面写，这里不再画标题、不再套卡片。 */
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
          {o.rounds.reason}
        </Notice>,
      );
    if (o.engineSteps.state === 'unavailable')
      notes.push(
        <Notice key="engine" tone="stall" title="引擎做的事没读到">
          {o.engineSteps.reason}
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
        <Stack gap="sm">
          {notes.length > 0 ? (
            <RowDetail indent={false}>
              <Stack gap="sm">{notes}</Stack>
            </RowDetail>
          ) : null}
          <RowDetail indent={false}>
            <Stack gap="sm">
              <RunBar runs={runs} now={now} onPick={jumpTo} />
              <BarAxis runs={runs} now={now} finished={finished} />
            </Stack>
          </RowDetail>
          <List>
            {timeline.map((g, i) => {
              const open = roundOpen(g, i);
              const isLast = i === timeline.length - 1;
              return (
                <li key={g.key}>
                  <section aria-label={g.seq === undefined ? '更早的几笔' : `第 ${g.seq} 回合`}>
                    <RoundHeader
                      g={g}
                      roundsKnown={o?.rounds.state === 'ok'}
                      isLast={isLast}
                      open={open}
                      onToggle={() => setRoundPicks((p) => ({ ...p, [g.key]: !open }))}
                    />
                    {open ? (
                      <List data-round-items>
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
                          <li data-next-steps>
                            <RowDetail indent={false}>
                              <Stack direction="horizontal" gap="sm" align="baseline">
                                <Text size="meta" tone="muted">
                                  接下来
                                </Text>
                                <Text size="meta" tone="secondary">
                                  {nextText}
                                </Text>
                              </Stack>
                            </RowDetail>
                          </li>
                        ) : null}
                      </List>
                    ) : null}
                  </section>
                </li>
              );
            })}
          </List>
        </Stack>
      )}
    </Section>
  );
}
