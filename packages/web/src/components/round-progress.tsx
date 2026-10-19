// 任务页页头下面「这一回合走到哪」（#3169）：第几回合、动手 → 自测 → 推分支 · CI → 验收 → 合并 五步各走到哪，
// 返工的回合带上一回合怎么收场。从「过程」同一份回合分组算（lib/task-process.ts 的 roundProgress），不另要后端字段；
// 回合读不到（老后端没给 overview、回合那块没读到）或没有回合记录的老单不画，不拿笔上的回合号猜。
// 每格两行（照设计稿，#3228）：上面步名，下面细节——做完的写用了多久、在做的写第几笔跑了多久或引擎在做什么、
// 没到的写还没到、没成的写停在这。
import { Check, LoaderCircle, X } from 'lucide-react';
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
import { cn } from '../lib/utils';

const SHORT_LABEL: Record<string, string> = { '推分支 · CI': 'CI' };

const STAGE: Record<RoundStageState, { className: string; said: string }> = {
  done: { className: 'border-border', said: '做完了' },
  now: { className: 'border-st-run-line bg-st-run-soft', said: '在做' },
  todo: { className: 'border-dashed border-border', said: '还没到' },
  failed: { className: 'border-st-fail-line bg-st-fail-soft', said: '没成' },
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
  if (d.overview?.rounds.state !== 'ok') return null;
  const p = roundProgress(buildTimeline(d.segmentRuns, d.overview), d.task.state);
  if (!p) return null;
  const nthOf = runOrder(d.segmentRuns);
  const why = p.reworkOf ? reworkDetail(p.reworkOf.outcome, p.reworkOf.summary) : undefined;
  const rework = p.reworkOf
    ? `上一回合${roundOutcome(p.reworkOf.outcome).label}${why ? `——${why}` : ''}`
    : undefined;
  return (
    <section
      data-round-progress
      aria-label={`第 ${p.seq} 回合走到哪`}
      className="flex min-w-0 flex-col gap-2"
    >
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-body sm:flex-nowrap">
        <span className="num shrink-0 font-semibold">第 {p.seq} 回合</span>
        <span className="shrink-0 text-muted-foreground">{p.note}</span>
        {rework ? (
          // 手机上返工原因单起一行，桌面跟在后面；太长截断，悬停看全文
          <span
            data-round-rework
            title={rework}
            className="min-w-0 basis-full truncate text-meta text-muted-foreground sm:basis-auto"
          >
            {rework}
          </span>
        ) : null}
      </p>
      <ol className="grid grid-cols-5 gap-1.5">
        {p.stages.map((s) => {
          const look = STAGE[s.state];
          const detail = stageDetail(s, nthOf, now);
          return (
            <li
              key={s.label}
              data-stage={s.label}
              data-stage-state={s.state}
              aria-current={s.state === 'now' ? 'step' : undefined}
              className={cn('flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-2', look.className)}
            >
              {/* 图标跟着步名：在做、没成的步名都短（动手、验收……），一格一百来像素也放得下；
                  做完的勾放第二行，免得「推分支 · CI」加勾挤不下 */}
              <span
                className={cn(
                  'flex min-w-0 items-center gap-1 text-meta font-medium',
                  s.state === 'todo' && 'text-muted-foreground',
                  s.state === 'now' && 'text-ink-run',
                  s.state === 'failed' && 'text-ink-fail',
                )}
              >
                {s.state === 'now' ? (
                  <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden />
                ) : s.state === 'failed' ? (
                  <X className="size-3 shrink-0" aria-hidden />
                ) : null}
                {/* 手机一格只有六十来像素，「推分支 · CI」写成「CI」，别的本来就两个字 */}
                <span className="min-w-0 truncate sm:hidden">{SHORT_LABEL[s.label] ?? s.label}</span>
                <span className="hidden min-w-0 truncate sm:inline">{s.label}</span>
              </span>
              {/* 第二行放不下就折行，不截断：「第 3 笔 · 40 分钟」截成「第 3 …」就没用了 */}
              <span
                className="num flex min-w-0 items-start gap-1 text-meta break-words text-muted-foreground"
                data-stage-detail
              >
                {s.state === 'done' ? (
                  <Check className="mt-0.5 size-3 shrink-0 text-ink-done" aria-hidden />
                ) : null}
                <span className="min-w-0">{detail}</span>
              </span>
              <span className="sr-only">{look.said}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
