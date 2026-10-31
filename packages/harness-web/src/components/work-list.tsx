// 任务的列表视图（#3784），窄屏的默认画面。一行＝状态点 + 名字 + 状态·用时 + 一行说明 + 右下类别·模型，整行可点。
// 有多波时按波分组（组头「第 N 波」）；组内失败、卡住的在前。没有运行的（排队中）点不开，行上写明。
import type { WorkGraph, WorkNode } from '@fleet-dao/harness-contract/work-graph';
import { ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '../lib/cn';
import { listRank, pct, resolveWaves, retried, retryCount, toneOf } from '../lib/work-model';
import { metaLine, StateDot, stateLine, TONE } from './work-card';

export function WorkList({
  graph,
  now,
  onOpen,
  openNodeIds,
}: {
  graph: WorkGraph;
  now: number;
  onOpen: (node: WorkNode) => void;
  openNodeIds?: ReadonlySet<string>;
}) {
  const groups = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return resolveWaves(graph).waves.map((w) => ({
      index: w.index,
      nodes: w.nodeIds
        .map((id) => byId.get(id))
        .filter((n): n is WorkNode => !!n)
        .sort((a, b) => listRank(a.state) - listRank(b.state)),
    }));
  }, [graph]);
  const multi = groups.length > 1;
  return (
    <div data-testid="work-list" className="min-h-0 flex-1 overflow-y-auto">
      {groups.map((g) => (
        <section key={g.index} className="border-b border-line">
          {multi ? (
            <h2 className="bg-subtle px-4 py-1.5 text-2xs font-medium text-ink-2">
              第 {g.index + 1} 波 <span className="num text-muted">· {g.nodes.length} 单</span>
            </h2>
          ) : null}
          <ul>
            {g.nodes.map((n) => {
              const openable = n.runIds.length > 0;
              const t = TONE[toneOf(n.state)];
              const row = (
                <>
                  <StateDot state={n.state} className="mt-2" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{n.label}</span>
                      {retried(n) ? (
                        <span className="num shrink-0 rounded-sm bg-neutral-soft px-1 text-2xs leading-4 text-ink-2">
                          ×{retryCount(n)}
                        </span>
                      ) : null}
                    </span>
                    <span className={cn('num flex items-center gap-2 text-2xs', t.text)}>
                      <span className="truncate">{stateLine(n, now)}</span>
                      {n.score ? (
                        <span className="shrink-0 text-muted">重合 {pct(n.score.lineJaccard)}</span>
                      ) : null}
                    </span>
                    <span className="block truncate text-2xs text-ink-2">{n.headline ?? '—'}</span>
                    <span className="block text-right text-2xs text-muted">{metaLine(n)}</span>
                  </span>
                  {openable ? (
                    <ChevronRight className="mt-2 size-4 shrink-0 text-line-strong" />
                  ) : (
                    <span className="w-4" />
                  )}
                </>
              );
              const cls = cn(
                'flex w-full items-start gap-3 border-t border-line px-4 py-2.5 text-left first:border-t-0',
                n.state === 'pending' && 'opacity-75',
                openNodeIds?.has(n.id) && 'bg-brand-soft/50',
              );
              return (
                <li key={n.id}>
                  {openable ? (
                    <button
                      type="button"
                      data-testid="work-row"
                      data-node-id={n.id}
                      data-state={n.state}
                      onClick={() => onOpen(n)}
                      className={cn(cls, 'cursor-pointer hover:bg-subtle')}
                    >
                      {row}
                    </button>
                  ) : (
                    <div
                      data-testid="work-row"
                      data-node-id={n.id}
                      data-state={n.state}
                      title="还没有运行，没有详情可看"
                      className={cls}
                    >
                      {row}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
