// 右侧面板（#3784）：点卡片开一个标签页，一次运行（runId）一个标签，可开多个、可关。
// 里面复用工人会话详情（会话号 worker-<runId>，SessionStream：过程流 + 进度 + 交结果串在一起），不另做一套。
// 一张单跑过多次的，面板头给「第 N 次」切换：每次尝试是它自己的标签。
import type { WorkGraph } from '@fleet-dao/harness-contract/work-graph';
import { ExternalLink, X } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { workStateLabel } from '../lib/labels';
import { SessionStream } from './session-stream';
import { StateDot } from './work-card';

export interface PanelTab {
  runId: string;
  nodeId: string;
  label: string;
}

export function WorkPanel({
  tabs,
  active,
  graph,
  onSelect,
  onClose,
  onOpenRun,
  className,
}: {
  tabs: readonly PanelTab[];
  active: string | null;
  graph: WorkGraph | null;
  onSelect: (runId: string) => void;
  onClose: (runId: string) => void;
  /** 在同一张单的另一次尝试上开标签。 */
  onOpenRun: (nodeId: string, label: string, runId: string) => void;
  className?: string;
}) {
  const tab = tabs.find((t) => t.runId === active) ?? null;
  const node = tab ? graph?.nodes.find((n) => n.id === tab.nodeId) : undefined;
  return (
    <aside
      data-testid="work-panel"
      aria-label="运行详情"
      className={cn('flex min-h-0 min-w-0 flex-col border-l border-line bg-surface', className)}
    >
      <div
        role="tablist"
        className="scrollbar-none flex shrink-0 items-stretch overflow-x-auto border-b border-line"
      >
        {tabs.map((t) => {
          const n = graph?.nodes.find((x) => x.id === t.nodeId);
          const nth = n ? n.runIds.indexOf(t.runId) + 1 : 0;
          const on = t.runId === active;
          return (
            <div
              key={t.runId}
              className={cn(
                'flex shrink-0 items-center border-b-2',
                on ? 'border-brand bg-brand-soft/40' : 'border-transparent',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={on}
                data-testid="panel-tab"
                data-run-id={t.runId}
                onClick={() => onSelect(t.runId)}
                className="flex h-10 max-w-48 cursor-pointer items-center gap-2 pr-1 pl-3 text-xs text-ink-2 hover:text-ink"
              >
                {n ? <StateDot state={n.state} /> : null}
                <span className="truncate font-medium">{t.label}</span>
                {n && n.runIds.length > 1 ? <span className="num text-muted">第 {nth} 次</span> : null}
              </button>
              <button
                type="button"
                aria-label={`关闭 ${t.label}`}
                data-testid="panel-tab-close"
                onClick={() => onClose(t.runId)}
                className="mr-1 grid size-6 cursor-pointer place-items-center rounded-sm text-muted hover:bg-neutral-soft hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      {tab ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-2xs text-ink-2">
            {node ? (
              <span className="font-medium text-ink">
                {node.label} · {workStateLabel(node.state)?.text ?? node.state}
              </span>
            ) : null}
            {node && node.runIds.length > 1 ? (
              <fieldset className="m-0 flex items-center gap-1 border-0 p-0" aria-label="切换尝试">
                {node.runIds.map((rid, i) => (
                  <button
                    key={rid}
                    type="button"
                    data-testid="attempt-switch"
                    aria-pressed={rid === tab.runId}
                    onClick={() => onOpenRun(node.id, node.label, rid)}
                    className={cn(
                      'num h-6 cursor-pointer rounded-sm border px-2',
                      rid === tab.runId
                        ? 'border-brand/40 bg-brand-soft text-brand-strong'
                        : 'border-line text-muted hover:text-ink',
                    )}
                  >
                    第 {i + 1} 次
                  </button>
                ))}
              </fieldset>
            ) : null}
            <Link
              to={`/s/worker-${tab.runId}`}
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-brand hover:underline"
            >
              整页打开
              <ExternalLink className="size-3" />
            </Link>
          </div>
          <SessionStream key={tab.runId} sessionId={`worker-${tab.runId}`} />
        </>
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center text-2xs text-muted">
          点图上的卡片，在这里看它的完整过程。
        </div>
      )}
    </aside>
  );
}
