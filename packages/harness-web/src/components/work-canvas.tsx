// 波次图画布（#3784）：@xyflow/react 管平移缩放，elkjs 管布局（波＝列，见 lib/work-layout.ts）。
// 视角规矩（OmO 的做法，出处见 PR）：打开时对准「当前活跃波」；用户手动拖过、缩放过就不再自动重适应，点「适应」才恢复；
// 缩放 0.6–1.6；滚轮平移、Ctrl/⌘+滚轮或捏合缩放；工具条有适应、上一波、下一波。
import '@xyflow/react/dist/style.css';
import type { WorkGraph, WorkNode } from '@fleet-dao/harness-contract/work-graph';
import { Background, type Edge, type Node, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { ChevronLeft, ChevronRight, Maximize } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { CARD_W, HEAD_H, type Layout, layoutGraph } from '../lib/work-layout';
import { activeWavePos, relatedIds, resolveWaves, toneOf, viewWaves, worstState } from '../lib/work-model';
import {
  CanvasContext,
  type CanvasCtx,
  type CardData,
  type HeadData,
  MoreCell,
  type MoreData,
  WaveHead,
  WorkCard,
} from './work-card';

const nodeTypes = { card: WorkCard, more: MoreCell, head: WaveHead };
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.6;
const PAD = 48;
const noop = () => undefined;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const reducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const EDGE_COLOR = {
  running: 'var(--color-brand)',
  success: 'var(--color-success)',
  danger: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  muted: 'var(--color-line-strong)',
} as const;

interface Props {
  graph: WorkGraph;
  now: number;
  onOpen: (node: WorkNode) => void;
  openNodeIds: ReadonlySet<string>;
  /** 波信息缺失已自动推算时，给顶栏提示。 */
  onRepaired?: (repaired: string | null) => void;
}

function Inner({ graph, now, onOpen, openNodeIds, onRepaired }: Props) {
  const rf = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const touched = useRef(false);
  /** 工具条「上一波/下一波」正要去的那一波（layout.waves 的下标）；视角被用户挪动或重新适应后清掉。 */
  const waveCursor = useRef<number | null>(null);
  const lastFramed = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const shownFor = useRef<string | null>(null);

  const resolved = useMemo(() => resolveWaves(graph), [graph]);
  useEffect(() => onRepaired?.(resolved.repaired), [resolved.repaired, onRepaired]);
  const views = useMemo(() => viewWaves(resolved.waves, expanded), [resolved.waves, expanded]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  // 布局只依赖「画哪些格子、有哪些边」，状态变化不重排
  const structure = useMemo(
    () =>
      `${graph.batchId}|${views.map((v) => `${v.index}:${v.compact ? 'c' : 'f'}:${v.shown.join(',')}`).join('|')}|${graph.edges.map((e) => `${e.from}>${e.to}`).join(',')}`,
    [graph.batchId, graph.edges, views],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在结构变时重排
  useEffect(() => {
    let live = true;
    void layoutGraph(views, graph.edges).then((l) => {
      if (live) setLayout(l);
    });
    return () => {
      live = false;
    };
  }, [structure]);

  // 换批次：回到「没接管」，视角重新对准活跃波，展开状态清掉
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在批次变时重置
  useEffect(() => {
    touched.current = false;
    shownFor.current = null;
    setExpanded(new Set());
    setLayout(null);
  }, [graph.batchId]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const activePos = useMemo(() => activeWavePos(resolved.waves, graph.nodes), [resolved.waves, graph.nodes]);

  /** 对准某一波（活跃波）：图放得下就整图居中，放不下就把这一波放在视口中间。 */
  const frame = useCallback(
    (pos: number, animate: boolean) => {
      if (!layout || size.w === 0 || size.h === 0 || layout.width === 0) return;
      // 窄屏工具条压在图上方一排，给它留出位置
      const top = size.w < 768 ? 52 : 0;
      const zoom = clamp(
        Math.min((size.w - PAD) / layout.width, (size.h - top - PAD) / layout.height),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      const waveIndex = resolved.waves[pos]?.index;
      const pw = layout.waves.find((w) => w.index === waveIndex);
      const x =
        layout.width * zoom <= size.w || !pw
          ? (size.w - layout.width * zoom) / 2
          : size.w / 2 - (pw.x + pw.w / 2) * zoom;
      const y =
        layout.height * zoom <= size.h - top
          ? top + (size.h - top - layout.height * zoom) / 2
          : top + PAD / 2;
      lastFramed.current = { x, y, zoom };
      waveCursor.current = null;
      void rf.setViewport({ x, y, zoom }, { duration: animate && !reducedMotion() ? 250 : 0 });
    },
    [layout, size, rf, resolved.waves],
  );

  // 没被用户接管时：布局出来、窗口变了、批次的活跃波变了，都自动对准
  useEffect(() => {
    if (!layout || touched.current) return;
    frame(activePos, false);
    shownFor.current = graph.batchId;
  }, [layout, frame, activePos, graph.batchId]);

  const fit = () => {
    touched.current = false;
    frame(activePos, true);
  };
  const stepWave = (dir: -1 | 1) => {
    if (!layout || layout.waves.length < 2) return;
    const vp = rf.getViewport();
    const cx = (size.w / 2 - vp.x) / vp.zoom;
    // 连点时动画还没走完，视口中线不准：以上一次要去的那一波为起点
    let near = waveCursor.current ?? 0;
    if (waveCursor.current === null) {
      let best = Number.POSITIVE_INFINITY;
      layout.waves.forEach((w, i) => {
        const d = Math.abs(w.x + w.w / 2 - cx);
        if (d < best) {
          best = d;
          near = i;
        }
      });
    }
    const target = clamp(near + dir, 0, layout.waves.length - 1);
    waveCursor.current = target;
    const to = layout.waves[target];
    if (!to) return;
    touched.current = true;
    void rf.setViewport(
      { x: size.w / 2 - (to.x + to.w / 2) * vp.zoom, y: vp.y, zoom: vp.zoom },
      { duration: reducedMotion() ? 0 : 250 },
    );
  };

  const related = useMemo(() => (hover ? relatedIds(hover, graph.edges) : null), [hover, graph.edges]);
  const toggleWave = useCallback((wave: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(wave)) next.delete(wave);
      else next.add(wave);
      return next;
    });
  }, []);
  const ctx = useMemo<CanvasCtx>(
    () => ({ now, onOpen, onHover: setHover, onToggleWave: toggleWave, openNodeIds }),
    [now, onOpen, toggleWave, openNodeIds],
  );

  const rfNodes = useMemo<Node[]>(() => {
    if (!layout) return [];
    const out: Node[] = [];
    for (const w of layout.waves) {
      const v = views.find((x) => x.index === w.index);
      const states = (v?.all ?? []).map((id) => nodeById.get(id)?.state ?? 'pending');
      const done = states.filter((s) => s === 'completed').length;
      const failed = states.filter((s) => s === 'failed').length;
      const running = states.filter((s) => s === 'running').length;
      const parts = [
        `${done}/${states.length} 完成`,
        running ? `${running} 在跑` : '',
        failed ? `${failed} 失败` : '',
      ];
      out.push({
        id: `head:${w.index}`,
        type: 'head',
        position: { x: w.x, y: 0 },
        data: {
          title: `第 ${w.index + 1} 波`,
          summary: parts.filter(Boolean).join(' · '),
          warn: failed > 0,
        } satisfies HeadData,
        width: CARD_W,
        height: HEAD_H - 4,
        draggable: false,
        selectable: false,
        focusable: false,
      });
    }
    for (const p of layout.nodes) {
      if (p.kind === 'more') {
        const v = views.find((x) => x.index === p.wave);
        out.push({
          id: p.id,
          type: 'more',
          position: { x: p.x, y: p.y },
          data: { wave: p.wave, more: v?.more ?? 0 } satisfies MoreData,
          width: p.w,
          height: p.h,
          draggable: false,
          selectable: false,
          focusable: false,
        });
        continue;
      }
      const node = nodeById.get(p.id);
      if (!node) continue;
      out.push({
        id: p.id,
        type: 'card',
        position: { x: p.x, y: p.y },
        data: { node, compact: p.h < 60, dim: related !== null && !related.has(p.id) } satisfies CardData,
        width: p.w,
        height: p.h,
        draggable: false,
        selectable: false,
        focusable: false,
      });
    }
    return out;
  }, [layout, views, nodeById, related]);

  const rfEdges = useMemo<Edge[]>(() => {
    if (!layout) return [];
    const placed = new Set(layout.nodes.map((n) => n.id));
    return graph.edges
      .filter((e) => placed.has(e.from) && placed.has(e.to))
      .map((e) => {
        // 边按上游里最糟的状态着色
        const ups = graph.edges
          .filter((x) => x.to === e.to)
          .map((x) => nodeById.get(x.from)?.state ?? 'pending');
        const dim = related !== null && !(related.has(e.from) && related.has(e.to));
        return {
          id: `${e.from}>${e.to}`,
          source: e.from,
          target: e.to,
          selectable: false,
          focusable: false,
          style: { stroke: EDGE_COLOR[toneOf(worstState(ups))], strokeWidth: 1.5, opacity: dim ? 0.2 : 1 },
        };
      });
  }, [layout, graph.edges, nodeById, related]);

  const multi = (layout?.waves.length ?? 0) > 1;
  return (
    <CanvasContext.Provider value={ctx}>
      <div
        ref={box}
        className="relative h-full min-h-0 w-full"
        data-testid="work-canvas"
        data-ready={layout ? '1' : '0'}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          // 节点不可选不可拖时 xyflow 会给节点加 pointer-events:none；卡片里有自己的按钮，这里给个空回调让它收事件
          onNodeClick={noop}
          panOnScroll
          zoomOnDoubleClick={false}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          onMove={(event, vp) => {
            // 程序自己挪视角时 event 是空的；有 event 且视角真的变了才算用户拖过、缩放过（光点一下卡片不算）：此后不再自动重适应
            const last = lastFramed.current;
            if (
              event &&
              last &&
              (Math.abs(vp.x - last.x) > 2 ||
                Math.abs(vp.y - last.y) > 2 ||
                Math.abs(vp.zoom - last.zoom) > 0.001)
            ) {
              touched.current = true;
              waveCursor.current = null;
            }
          }}
          proOptions={{ hideAttribution: false }}
          aria-label="任务波次图"
          className="bg-canvas"
        >
          <Background gap={24} size={1} color="var(--color-line)" />
        </ReactFlow>
        <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-md border border-line bg-surface p-1 shadow-xs">
          <ToolButton label="适应" onClick={fit} testid="fit">
            <Maximize className="size-3.5" />
            适应
          </ToolButton>
          <ToolButton label="上一波" onClick={() => stepWave(-1)} disabled={!multi} testid="prev-wave">
            <ChevronLeft className="size-3.5" />
            <span className="max-sm:sr-only">上一波</span>
          </ToolButton>
          <ToolButton label="下一波" onClick={() => stepWave(1)} disabled={!multi} testid="next-wave">
            <span className="max-sm:sr-only">下一波</span>
            <ChevronRight className="size-3.5" />
          </ToolButton>
        </div>
      </div>
    </CanvasContext.Provider>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  testid,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-7 cursor-pointer items-center gap-1 rounded-sm px-2 text-2xs text-ink-2 hover:bg-neutral-soft hover:text-ink',
        'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}

export function WorkCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
