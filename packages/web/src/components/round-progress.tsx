// 任务页页头下面「这一回合走到哪」（#3169）：第几回合、动手 → 自测 → 推分支 · CI → 验收 → 合并 五步各走到哪，
// 返工的回合带上一回合怎么收场。从「过程」同一份回合分组算（lib/task-process.ts 的 roundProgress），不另要后端字段；
// 回合读不到（老后端没给 overview、回合那块没读到）或没有回合记录的老单整条不画，不拿笔上的回合号猜。
// 样子照 Arco 步骤条（#3509）：做完是勾，在做是蓝底序号，没成是红叉，没到是灰圈；每步下面一行细节——
// 做完的写用了多久、在做的写第几笔跑了多久或引擎在做什么、没到的写还没到、没成的写停在这。

import type { TaskDetail } from '../api/types';
import { formatDuration } from '../lib/format';
import {
  ACTIVITY_LABEL,
  buildTimeline,
  type RoundProgress,
  type RoundStageState,
  reworkDetail,
  roundOutcome,
  roundProgress,
  runDurationMs,
  runOrder,
} from '../lib/task-process';
import { usePhone } from '../lib/viewport';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import type { StepStatus } from './layout/steps';
import { Steps } from './layout/steps';
import { Text } from './layout/text';

const SHORT_LABEL: Record<string, string> = { '推分支 · CI': 'CI' };

const STEP_STATUS: Record<RoundStageState, StepStatus> = {
  done: 'finish',
  now: 'process',
  todo: 'wait',
  failed: 'error',
};

type Stage = RoundProgress['stages'][number];

/** 每格第二行写什么。 */
export function stageDetail(s: Stage, nthOf: ReadonlyMap<string, number>, now: number): string {
  if (s.state === 'todo') return '还没到';
  if (s.state === 'failed') return '停在这';
  if (s.state === 'now') {
    const last = s.items.at(-1);
    if (!last) return '还没开跑';
    if (last.kind === 'run') {
      const ms = runDurationMs(last.run, now);
      return `第 ${nthOf.get(last.run.id) ?? '?'} 笔${ms !== undefined ? ` · ${formatDuration(ms)}` : ''}`;
    }
    if (last.kind === 'engine') return `${ACTIVITY_LABEL[last.step.activity] ?? last.step.activity}中`;
    return '在做';
  }
  const ms = s.items.reduce(
    (n, it) =>
      n + (it.kind === 'run' ? (runDurationMs(it.run, now) ?? 0) : it.kind === 'engine' ? it.step.runMs : 0),
    0,
  );
  return ms > 0 ? formatDuration(ms) : '做完了';
}

export function RoundProgressStrip({ d, now }: { d: TaskDetail; now: number }) {
  const phone = usePhone();
  if (d.overview?.rounds.state !== 'ok') return null;
  const p = roundProgress(buildTimeline(d.segmentRuns, d.overview), d.task.state);
  if (!p) return null;
  const nthOf = runOrder(d.segmentRuns);
  const why = p.reworkOf ? reworkDetail(p.reworkOf.outcome, p.reworkOf.summary) : undefined;
  const rework = p.reworkOf
    ? `上一回合${roundOutcome(p.reworkOf.outcome).label}${why ? `——${why}` : ''}`
    : undefined;
  return (
    <Section aria-label={`第 ${p.seq} 回合走到哪`} data-round-progress>
      <Stack gap="md">
        <Stack direction="horizontal" gap="md" align="baseline">
          <Text strong>第 {p.seq} 回合</Text>
          <Text tone="muted">{p.note}</Text>
          {rework ? (
            // 太长截断，悬停看全文
            <span data-round-rework title={rework}>
              <Text size="meta" tone="muted" truncate>
                {rework}
              </Text>
            </span>
          ) : null}
        </Stack>
        <Steps
          items={p.stages.map((s) => ({
            id: s.label,
            // 手机一格只有几十像素，「推分支 · CI」写成「CI」，别的本来就两个字
            title: phone ? (SHORT_LABEL[s.label] ?? s.label) : s.label,
            description: stageDetail(s, nthOf, now),
            status: STEP_STATUS[s.state],
          }))}
        />
      </Stack>
    </Section>
  );
}
