// 任务页页头下面「这一回合走到哪」（#3169）：第几回合、动手 → 自测 → 推分支 · CI → 验收 → 合并 五步各走到哪，
// 返工的回合带上一回合怎么收场。从「过程」同一份回合分组算（lib/task-process.ts 的 roundProgress），不另要后端字段；
// 回合读不到（老后端没给 overview、回合那块没读到）或没有回合记录的老单不画，不拿笔上的回合号猜。
import { Check, Circle, CircleDot, X } from 'lucide-react';
import type { TaskDetail } from '../api/types';
import {
  buildTimeline,
  type RoundStageState,
  reworkDetail,
  roundOutcome,
  roundProgress,
} from '../lib/task-process';
import { cn } from '../lib/utils';

const SHORT_LABEL: Record<string, string> = { '推分支 · CI': 'CI' };

const STAGE: Record<RoundStageState, { className: string; icon: typeof Check; said: string }> = {
  done: { className: 'border-border text-foreground', icon: Check, said: '做完了' },
  now: { className: 'border-st-run-line bg-st-run-soft text-ink-run', icon: CircleDot, said: '在做' },
  todo: { className: 'border-dashed border-border text-muted-foreground', icon: Circle, said: '还没到' },
  failed: { className: 'border-st-fail-line bg-st-fail-soft text-ink-fail', icon: X, said: '没成' },
};

export function RoundProgressStrip({ d }: { d: TaskDetail }) {
  if (d.overview?.rounds.state !== 'ok') return null;
  const p = roundProgress(buildTimeline(d.segmentRuns, d.overview), d.task.state);
  if (!p) return null;
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
          const Icon = look.icon;
          return (
            <li
              key={s.label}
              data-stage={s.label}
              data-stage-state={s.state}
              aria-current={s.state === 'now' ? 'step' : undefined}
              className={cn(
                'flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-meta',
                look.className,
              )}
            >
              <Icon className={cn('size-3.5 shrink-0', s.state === 'done' && 'text-ink-done')} aria-hidden />
              {/* 手机一格只有六十来像素，「推分支 · CI」写成「CI」，别的本来就两个字 */}
              <span className="min-w-0 truncate sm:hidden">{SHORT_LABEL[s.label] ?? s.label}</span>
              <span className="hidden min-w-0 truncate sm:inline">{s.label}</span>
              <span className="sr-only">{look.said}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
