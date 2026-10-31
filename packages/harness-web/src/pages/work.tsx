import type { WorkNode } from '@fleet-dao/harness-contract/work-graph';
import { countStates } from '@fleet-dao/harness-contract/work-graph';
import { LayoutList, Network, Workflow } from 'lucide-react';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Chip } from '../components/chip';
import { LoginPrompt } from '../components/login-prompt';
import { PageBar } from '../components/shell';
import { WorkList } from '../components/work-list';
import { type PanelTab, WorkPanel } from '../components/work-panel';
import { cn } from '../lib/cn';
import { formatRelative } from '../lib/format';
import { workStateLabel } from '../lib/labels';
import {
  readView,
  useBatches,
  useBatchGraph,
  useMediaQuery,
  useNow,
  type WorkView,
  writeView,
} from '../lib/work-hooks';

// 画布连同 elk 比较大，只有看图的时候才加载
const WorkCanvas = lazy(() => import('../components/work-canvas').then((m) => ({ default: m.WorkCanvas })));

const SUMMARY_ORDER = [
  'running',
  'failed',
  'blocked',
  'paused',
  'scheduled',
  'pending',
  'completed',
  'cancelled',
  'skipped',
];

/**
 * 任务页：一批影子批次一张图，一单一张卡（以后编排做出来就是多波依赖图，同一个形状）。
 * 电脑：左边画布，点卡片在右侧开面板标签页看这次运行的完整过程；手机（768 以下）：默认列表，整行点进整页的会话详情，可切到图。
 */
export function Work() {
  const narrow = useMediaQuery('(max-width: 767px)');
  const [stored, setStored] = useState<WorkView | null>(readView);
  const view: WorkView = stored ?? (narrow ? 'list' : 'graph');
  const setView = (v: WorkView) => {
    setStored(v);
    writeView(v);
  };

  const batches = useBatches();
  const [picked, setPicked] = useState<string | null>(null);
  const list = batches.data?.batches ?? [];
  const batchId = picked ?? list[0]?.batchId ?? null;
  const g = useBatchGraph(batchId);
  const graph = g.data && g.data.batchId === batchId ? g.data : null;
  const now = useNow(true);

  const [tabs, setTabs] = useState<PanelTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [repaired, setRepaired] = useState<string | null>(null);
  const navigate = useNavigate();

  const openRun = useCallback((nodeId: string, label: string, runId: string) => {
    setTabs((prev) => (prev.some((t) => t.runId === runId) ? prev : [...prev, { runId, nodeId, label }]));
    setActive(runId);
  }, []);
  const onOpen = useCallback(
    (node: WorkNode) => {
      const runId = node.runIds.at(-1);
      if (!runId) return;
      if (narrow) navigate(`/s/worker-${runId}`);
      else openRun(node.id, node.label, runId);
    },
    [narrow, navigate, openRun],
  );
  const closeTab = (runId: string) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.runId === runId);
      const next = prev.filter((t) => t.runId !== runId);
      if (active === runId) setActive(next[Math.min(i, next.length - 1)]?.runId ?? null);
      return next;
    });
  };
  const pickBatch = (id: string) => {
    setPicked(id);
    setTabs([]);
    setActive(null);
  };
  const openNodeIds = useMemo(() => new Set(tabs.map((t) => t.nodeId)), [tabs]);
  const counts = useMemo(() => (graph ? countStates(graph.nodes) : {}), [graph]);

  const unauthorized = batches.unauthorized || g.unauthorized;
  const showPanel = !narrow && tabs.length > 0;
  const failedOnly = !graph && (batches.error || g.error);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar
        title="任务"
        extra={
          <fieldset
            aria-label="图或列表"
            className="m-0 flex min-w-0 items-center rounded-md border border-line bg-surface p-0.5"
          >
            {(
              [
                ['graph', '图', <Network key="g" className="size-3.5" />],
                ['list', '列表', <LayoutList key="l" className="size-3.5" />],
              ] as const
            ).map(([v, text, icon]) => (
              <button
                key={v}
                type="button"
                data-testid={`view-${v}`}
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'inline-flex h-7 cursor-pointer items-center gap-1 rounded-sm px-2 text-2xs',
                  view === v ? 'bg-brand-soft font-medium text-brand-strong' : 'text-muted hover:text-ink',
                )}
              >
                {icon}
                {text}
              </button>
            ))}
          </fieldset>
        }
      >
        {list.length > 0 ? (
          <label className="flex min-w-0 items-center gap-2 text-2xs text-muted">
            <span className="shrink-0 max-sm:sr-only">批次</span>
            <select
              data-testid="batch-select"
              value={batchId ?? ''}
              onChange={(e) => pickBatch(e.target.value)}
              className="h-8 min-w-0 max-w-full cursor-pointer rounded-md border border-line bg-surface px-2 text-xs text-ink"
            >
              {list.map((b) => (
                <option key={b.batchId} value={b.batchId}>
                  {b.batchId} · {b.items} 单 · 做完 {b.counts.completed ?? 0}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </PageBar>
      <div className="flex h-[calc(100dvh-var(--bar-h)*2)] min-h-0 md:h-[calc(100dvh-var(--bar-h))]">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {unauthorized && !graph ? (
            <LoginPrompt />
          ) : failedOnly ? (
            <div
              role="alert"
              data-testid="work-error"
              className="m-4 rounded-lg border border-line bg-danger-soft p-4 text-sm text-danger"
            >
              读不到任务数据：{batches.error ?? g.error}
              <p className="mt-1 text-2xs text-ink-2">会自动重试，间隔逐渐拉长；不用刷新。</p>
            </div>
          ) : batches.loading || (batchId !== null && !graph) ? (
            <p className="p-6 text-center text-sm text-muted" data-testid="work-loading">
              正在加载任务…
            </p>
          ) : batchId === null || !graph ? (
            <div className="grid flex-1 place-items-center p-6 text-center" data-testid="work-empty">
              <div className="max-w-sm">
                <Workflow className="mx-auto size-8 text-line-strong" />
                <p className="mt-3 text-sm font-medium text-ink-2">还没有可看的批次</p>
                <p className="mt-1 text-2xs text-muted">
                  影子批次冻结并开始跑之后，一批一张图、一单一张卡会出现在这里；编排做出来后，拆出的子任务也画在这里。
                </p>
              </div>
            </div>
          ) : (
            <>
              <div
                data-testid="work-summary"
                className="scrollbar-none flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-surface px-4 py-2 text-2xs text-ink-2 md:px-6"
              >
                <span className="num shrink-0">共 {graph.truncatedFrom ?? graph.nodes.length} 单</span>
                {SUMMARY_ORDER.filter((s) => counts[s]).map((s) => (
                  <Chip
                    key={s}
                    tone={
                      s === 'failed'
                        ? 'danger'
                        : s === 'blocked' || s === 'paused'
                          ? 'warning'
                          : s === 'running'
                            ? 'brand'
                            : 'neutral'
                    }
                  >
                    {workStateLabel(s)?.text} <span className="num ml-1">{counts[s]}</span>
                  </Chip>
                ))}
                {graph.truncatedFrom ? <Chip tone="warning">只显示前 {graph.nodes.length} 单</Chip> : null}
                {repaired ? <Chip tone="warning">波信息缺失，已自动推算</Chip> : null}
                <span className="num ml-auto shrink-0 pl-2 text-muted" data-testid="work-updated">
                  {g.error
                    ? `读失败，显示 ${g.updatedAt ? formatRelative(new Date(g.updatedAt).toISOString(), now) : '之前'} 的快照`
                    : g.updatedAt
                      ? `更新于 ${formatRelative(new Date(g.updatedAt).toISOString(), now)}`
                      : ''}
                </span>
              </div>
              {g.error ? (
                <div
                  role="status"
                  className="shrink-0 border-b border-line bg-warning-soft px-4 py-1.5 text-2xs text-warning md:px-6"
                >
                  读不到最新状态（{g.error}），已显示的不会丢；第 {g.failures} 次失败，会自动重试。
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                {view === 'graph' ? (
                  <Suspense fallback={<p className="p-6 text-center text-sm text-muted">正在加载画布…</p>}>
                    <WorkCanvas
                      graph={graph}
                      now={now}
                      onOpen={onOpen}
                      openNodeIds={openNodeIds}
                      onRepaired={setRepaired}
                    />
                  </Suspense>
                ) : (
                  <div className="flex h-full flex-col">
                    <WorkList graph={graph} now={now} onOpen={onOpen} openNodeIds={openNodeIds} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        {showPanel ? (
          <WorkPanel
            tabs={tabs}
            active={active}
            graph={graph}
            onSelect={setActive}
            onClose={closeTab}
            onOpenRun={openRun}
            className="w-[min(520px,45%)] shrink-0"
          />
        ) : null}
      </div>
    </div>
  );
}
