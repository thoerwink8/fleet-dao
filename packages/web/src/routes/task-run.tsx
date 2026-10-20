// 弹出到新窗口的那一笔会话（#3277）：不带外壳。左边按回合列整张单的笔，点一笔换一笔；右边居中放会话，宽屏读长会话用。
import { ChevronLeft } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { brand } from '#brand';
import { isNotFound, useTaskDetail } from '../api/client';
import { EmptyState } from '../components/layout/empty-state';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { RunMeta, RunOutcomeBadge, RunTranscript, runTitle } from '../components/run-transcript';
import { orderedRuns, runPopoutPath } from '../components/task-panel';
import { formatDuration } from '../lib/format';
import { useNow } from '../lib/hooks';
import { liveMs, type SegmentRunView } from '../lib/segments';
import { useShownError } from '../lib/shown-error';
import { cn } from '../lib/utils';

interface RoundGroup {
  key: string;
  label: string;
  runs: { run: SegmentRunView; nth: number }[];
}

/** 按回合分组，组内和组间都按起跑先后；不挂回合的（定范围这类开工前的段）单独一组。 */
export function groupByRound(runs: readonly SegmentRunView[]): RoundGroup[] {
  const groups = new Map<string, RoundGroup>();
  orderedRuns(runs).forEach((run, i) => {
    const key = run.roundSeq === undefined ? 'none' : String(run.roundSeq);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: run.roundSeq === undefined ? '不在回合里' : `第 ${run.roundSeq} 回合`, runs: [] };
      groups.set(key, g);
    }
    g.runs.push({ run, nth: i + 1 });
  });
  return [...groups.values()];
}

function RunList({
  taskId,
  groups,
  current,
  now,
}: {
  taskId: string;
  groups: RoundGroup[];
  current: string;
  now: number;
}) {
  return (
    <nav aria-label="这张单的笔" className="min-h-0 overflow-y-auto scrollbar-thin p-2" data-popout-runs>
      {groups.map((g) => (
        <div key={g.key} className="mb-3">
          <p className="px-2 pb-1 text-meta text-muted-foreground">{g.label}</p>
          <ul className="space-y-0.5">
            {g.runs.map(({ run, nth }) => {
              const live = liveMs(run, now);
              const ms = run.durationMs ?? live;
              return (
                <li key={run.id}>
                  <Link
                    to={runPopoutPath(taskId, run.id)}
                    replace
                    aria-current={run.id === current ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-2 py-1.5 text-body hover:bg-accent',
                      run.id === current && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate">{runTitle(run, nth)}</span>
                      <RunOutcomeBadge run={run} />
                    </span>
                    <span className="num block truncate text-meta text-muted-foreground">
                      {[run.modelName, ms !== undefined ? formatDuration(ms) : '耗时没读到']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export default function TaskRunPage() {
  const { taskId = '', runId = '' } = useParams();
  const detail = useTaskDetail(taskId);
  // 推送重读会把从没读成过的查询退回骨架：显示记住的那次失败（和任务页一样，lib/shown-error.ts）
  const error = useShownError(taskId, detail);
  const now = useNow();
  const d = detail.data;
  const groups = d ? groupByRound(d.segmentRuns) : [];
  const found = groups.flatMap((g) => g.runs).find((r) => r.run.id === runId);
  const taskPath = `/tasks/${encodeURIComponent(taskId)}`;

  useEffect(() => {
    const what = found ? runTitle(found.run, found.nth) : '会话';
    document.title = d ? `${what} · #${d.task.issueNumber} · ${brand.product}` : `${what} · ${brand.product}`;
  }, [d, found]);

  const back = (
    <Link
      to={taskPath}
      className="inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
      data-popout-back
    >
      <ChevronLeft className="size-4" aria-hidden />
      回到任务页
    </Link>
  );

  if (error && !d) {
    return (
      <div className="mx-auto w-full max-w-xl space-y-4 p-6">
        {back}
        {isNotFound(error) ? (
          <EmptyState title="没有这张单" hint={`任务 ${taskId} 不在库里，可能编号写错了。`} />
        ) : (
          <LoadError what="这张单" error={error} onRetry={() => void detail.refetch()} />
        )}
      </div>
    );
  }
  if (!d) {
    return (
      <div className="mx-auto w-full max-w-xl p-6">
        <LoadingRows rows={6} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-sidebar shrink-0 flex-col border-r bg-panel md:flex">
        <div className="space-y-1 border-b p-3">
          {back}
          <p className="truncate text-body">
            <span className="num text-muted-foreground">#{d.task.issueNumber}</span> {d.task.title}
          </p>
        </div>
        <RunList taskId={taskId} groups={groups} current={runId} now={now} />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {found ? (
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 pt-4">
            <div className="mb-2 md:hidden">{back}</div>
            <header className="mb-2 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-title" data-popout-title>
                  {runTitle(found.run, found.nth)}
                </h1>
                <RunOutcomeBadge run={found.run} />
              </div>
              <RunMeta run={found.run} now={now} />
            </header>
            <div className="flex min-h-0 flex-1 flex-col">
              <RunTranscript taskId={taskId} run={found.run} />
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-xl space-y-4 p-6">
            <div className="md:hidden">{back}</div>
            <EmptyState
              title="没有这一笔"
              hint="这张单里找不到这一笔，可能是地址写错了。左边列着这张单的全部笔。"
            />
          </div>
        )}
      </main>
    </div>
  );
}
