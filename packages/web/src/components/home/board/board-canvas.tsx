// 首页「在跑的」画布：React Flow + ELK 两侧展开的思维导图（初版 PR #13 的样子和手感，#613 删掉后按创始人 2026-10-07
// 「react-flow 我还是喜欢初版那样」搬回来）。中心是引擎，第一层三段（对题 / 动手 / 验收），第二层每张单，等你拍的再挂一片叶子。
// 三级缩放、在跑的卡片呼吸、连线流动、聚焦、过滤、全键盘、悬停和右键快捷操作、右侧详情、「此刻」谁在干活、小地图都照初版。
//
// 改这里之前必须知道：
// - 首页能往下滚（窄一点的屏「做完的」在画布下面）：滚轮不缩放、不拦页面滚动；缩放用按钮、键盘 1/2/3/+/-/0，
//   或按住 Ctrl 滚（触控板捏合同理）。
// - 节点必须带死的 width / height：react-flow 量不到尺寸的节点会先隐藏，测试环境（happy-dom）里就全是空的。
// - 量不到画布尺寸（测试环境宽高恒为 0）时不「全部收进视野」，留在缩放 1（中景），免得按 0×0 算出一个极小的缩放。
import '@xyflow/react/dist/style.css';
import {
  Background,
  BackgroundVariant,
  type Edge,
  getViewportForBounds,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
} from '@xyflow/react';
import {
  ChevronDown,
  Focus,
  Hand,
  Keyboard,
  Maximize,
  MessageCircleQuestion,
  Minus,
  Palette,
  Plus,
  TriangleAlert,
} from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { formatDuration } from '../../../lib/format';
import { useLocalState, useMediaQuery, useNow } from '../../../lib/hooks';
import { type Tone, toneLabel } from '../../../lib/status';
import { cn } from '../../../lib/utils';
import { useRemoteView } from '../../node-notice';
import { StatusDot } from '../../status';
import { shortcutAction, useTaskActions } from '../../task-actions';
import { useTheme } from '../../theme-provider';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/dialog';
import { Kbd } from '../../ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { statusTextOf } from '../running-card';
import type { HomeFlowStage, HomeHealth, HomeRunning } from '../types';
import {
  BoardUiContext,
  createBoardView,
  githubIssueLink,
  itemOf,
  targetOfItem,
  useZoomLevel,
  ZOOM_OF,
  type ZoomLevel,
} from './board-ui';
import { DetailPanel } from './detail-panel';
import { layoutGraph, type Positions } from './layout';
import {
  type BoardNodeData,
  buildGraph,
  type Graph,
  type GraphEdge,
  lineage,
  nodeId,
  ROOT_ID,
  ticketTone,
  worstTone,
} from './model';
import { type BoardNode, nodeTypes } from './nodes';
import { toneVar } from './tones';

export interface BoardCanvasProps {
  running: readonly HomeRunning[];
  flow: readonly HomeFlowStage[];
  health?: HomeHealth | undefined;
}

export function BoardCanvas(props: BoardCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

/** 同时流动的连线上限：再多就改成静止虚线（中景帧率的主要开销，见 PR #13 的压测）。 */
const MAX_ANIMATED_EDGES = 60;
/** 节点多于这个数时只渲染视野里的卡片和连线。 */
const VISIBLE_ONLY_ABOVE = 150;

/** 两份节点数据是否画出来一样：单子对象靠 React Query 的结构共享，没变就是同一个对象。 */
export function sameNodeData(a: BoardNodeData, b: BoardNodeData): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case 'root':
      return (
        b.kind === 'root' &&
        a.engine === b.engine &&
        a.repos.join('|') === b.repos.join('|') &&
        JSON.stringify(a.counts) === JSON.stringify(b.counts)
      );
    case 'segment':
      return (
        b.kind === 'segment' &&
        a.key === b.key &&
        a.stage === b.stage &&
        a.total === b.total &&
        a.side === b.side &&
        JSON.stringify(a.counts) === JSON.stringify(b.counts)
      );
    case 'ticket':
      return b.kind === 'ticket' && a.item === b.item && a.side === b.side && a.key === b.key;
    case 'ask':
      return b.kind === 'ask' && a.item === b.item && a.side === b.side && a.text === b.text;
  }
}

function toEdge(e: GraphEdge, o: { dim: boolean; fromRoot: boolean; animate: boolean }): Edge {
  const colored = e.tone === 'run' || e.tone === 'stall' || e.tone === 'fail' || e.tone === 'human';
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    // 中心节点左右各一个接头。
    ...(o.fromRoot ? { sourceHandle: e.side === 'left' ? 'l' : 'r' } : {}),
    animated: e.live && o.animate,
    style: {
      stroke: colored ? `color-mix(in oklab, ${toneVar[e.tone]} 75%, transparent)` : 'var(--border-strong)',
      strokeWidth: e.live ? 1.8 : 1.3,
      // 在跑但不流动的线画成静止虚线，照样和普通连线分得开。
      ...(e.live && !o.animate ? { strokeDasharray: '5 4' } : {}),
      opacity: o.dim ? 0.1 : 1,
    },
  };
}

/** 「减少动效」：设置页的开关，或者系统的减少动态效果，任一个开着都算。 */
function useReducedMotion(): boolean {
  const { pref } = useTheme();
  const system = useMediaQuery('(prefers-reduced-motion: reduce)');
  return pref.motion === 'reduced' || system;
}

function toneOfData(d: BoardNodeData): Tone {
  switch (d.kind) {
    case 'ticket':
      return ticketTone(d.item);
    case 'ask':
      return 'human';
    case 'segment':
      return d.total ? worstTone(d.counts) : 'wait';
    default:
      return 'wait';
  }
}

/**
 * 方向键按画面方向走：往外（远离中心）是子节点，往里是父节点；上下在同一层、同一侧里按纵向位置走。
 * 右半边「→」是往外，左半边「←」是往外；在中心上按「→ / ←」进右边 / 左边。
 */
function neighbour(graph: Graph, pos: Positions, current: string | null, key: string): string | null {
  const root = graph.nodes[0]?.id ?? null;
  const node = current ? graph.nodes.find((n) => n.id === current) : undefined;
  if (!node || !current) return root;
  const y = (id: string) => pos.get(id)?.y ?? 0;
  const nearestKid = (kids: string[]) => {
    if (!kids.length) return null;
    const cy = y(current);
    return kids.reduce(
      (best, k) => (Math.abs(y(k) - cy) < Math.abs(y(best) - cy) ? k : best),
      kids[0] as string,
    );
  };
  const kids = graph.childrenOf.get(current) ?? [];
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const towardRight = key === 'ArrowRight';
    if (!node.side) {
      const side = towardRight ? 'right' : 'left';
      return nearestKid(kids.filter((k) => graph.nodes.find((n) => n.id === k)?.side === side));
    }
    const outward = (node.side === 'right') === towardRight;
    return outward ? nearestKid(kids) : (graph.parentOf.get(current) ?? null);
  }
  const layer = graph.nodes
    .filter((n) => n.data.kind === node.data.kind && n.side === node.side)
    .map((n) => n.id)
    .sort((a, b) => y(a) - y(b));
  const i = layer.indexOf(current);
  return layer[key === 'ArrowDown' ? i + 1 : i - 1] ?? null;
}

function Canvas({ running, flow, health }: BoardCanvasProps) {
  const navigate = useNavigate();
  const remote = useRemoteView() !== null;
  const [params, setParams] = useSearchParams();
  const stuck = params.get('stuck') === '1';
  const needsYou = params.get('you') === '1';
  const selectedId = params.get('sel');
  const [focusMode, setFocusMode] = useState(false);
  const [help, setHelp] = useState(false);
  const { trigger } = useTaskActions();
  const rf = useReactFlow();
  const flowStore = useStoreApi();
  const wrapper = useRef<HTMLDivElement>(null);
  // 远档标题的字号用这两个变量：预设缩放写死一次，当前缩放跟着画布变，节点不必逐帧重画。
  useLayoutEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    el.style.setProperty('--fd-zoom-far', String(ZOOM_OF.far));
    let last = Number.NaN;
    const apply = () => {
      const z = flowStore.getState().transform[2];
      const next = z > 0 ? z : ZOOM_OF.far;
      if (next === last) return;
      last = next;
      el.style.setProperty('--fd-board-zoom', String(next));
    };
    apply();
    return flowStore.subscribe(apply);
  }, [flowStore]);
  const [view] = useState(createBoardView);

  const graph = useMemo(
    () => buildGraph({ running, flow, health, filter: { stuck, needsYou } }),
    [running, flow, health, stuck, needsYou],
  );
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const [positions, setPositions] = useState<Positions | null>(null);
  const structureKey = graph.structureKey;
  const viewKey = `${stuck}:${needsYou}`;
  const fitted = useRef('');

  // 只有节点集合变了才重新排版；状态变化（颜色、文字）不动位置。
  // 排不出来要说出来：之前排好的画面留着，上面压一条「排版没成」带重试；一次都没排成就在画布中间说。
  const [layoutError, setLayoutError] = useState<Error | null>(null);
  const [layoutTry, setLayoutTry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutTry 只用来触发重试。
  useEffect(() => {
    let alive = true;
    const g = graphRef.current;
    if (g.structureKey !== structureKey) return;
    layoutGraph(g).then(
      (p) => {
        if (!alive) return;
        setLayoutError(null);
        setPositions(p);
      },
      (err: unknown) => {
        if (alive) setLayoutError(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return () => {
      alive = false;
    };
  }, [structureKey, layoutTry]);

  /**
   * 全部收进视野。位置和尺寸都是自己排的、已知的，直接按它们算，不等 React Flow 量卡片。
   * 让开浮在画布上的东西：顶上的工具条，左下的「此刻」，右下的小地图。
   */
  const fitAll = useCallback(
    (duration = 400) => {
      const el = wrapper.current;
      if (!positions || !el) return;
      const box = el.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (const n of graphRef.current.nodes) {
        const p = positions.get(n.id);
        if (!p) continue;
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x + n.width);
        y1 = Math.max(y1, p.y + n.height);
      }
      if (!Number.isFinite(x0)) return;
      const bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      const inset = (sel: string) => {
        const r = el.querySelector(sel)?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0 ? r : undefined;
      };
      const toolbar = inset('[data-board-toolbar]');
      const nowBox = inset('[data-board-now]');
      const mini = inset('.react-flow__minimap');
      const top = toolbar ? toolbar.bottom - box.top + 12 : 16;
      const gap = 12;
      const bottomSpace = Math.max(nowBox?.height ?? 0, mini?.height ?? 0) + gap * 2;
      const fits = [
        { top, bottom: bottomSpace, left: 16, right: 16 },
        {
          top,
          bottom: 16,
          left: (nowBox ? nowBox.right - box.left : 0) + gap,
          right: (mini ? box.right - mini.left : 0) + gap,
        },
      ].map((pad) => {
        const w = Math.max(80, box.width - pad.left - pad.right);
        const h = Math.max(80, box.height - pad.top - pad.bottom);
        const vp = getViewportForBounds(bounds, w, h, 0.15, 1, 0.02);
        return { ...vp, x: vp.x + pad.left, y: vp.y + pad.top };
      });
      const vp = fits.reduce((a, b) => (b.zoom > a.zoom ? b : a));
      void rf.setViewport(vp, { duration });
    },
    [positions, rf],
  );

  // 排好版、或换了过滤条件后，整体收进视野一次；之后不乱动用户的视角。
  useEffect(() => {
    if (!positions || fitted.current === viewKey) return;
    if (!graphRef.current.nodes.every((n) => positions.has(n.id))) return;
    fitted.current = viewKey;
    fitAll(450);
  }, [positions, viewKey, fitAll]);

  const setParam = useCallback(
    (key: string, value: string | null) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (value === null) p.delete(key);
          else p.set(key, value);
          return p;
        },
        { replace: true, preventScrollReset: true },
      ),
    [setParams],
  );

  // 选中项记在网址里（?sel=）；键盘连按以这里记的为准，不然第二下会从旧的选中项算起。
  const selRef = useRef<string | null>(selectedId);
  useEffect(() => {
    selRef.current = selectedId;
  }, [selectedId]);
  const select = useCallback(
    (id: string | null) => {
      selRef.current = id;
      setParam('sel', id);
    },
    [setParam],
  );
  const open = useCallback(
    (id: string) => {
      const n = graphRef.current.nodes.find((x) => x.id === id);
      const item = n ? itemOf(n.data) : undefined;
      if (!n || !item) return;
      if (remote) {
        // 看别的环境的快照：站内详情读的是本台的库、对不上，去 GitHub 上那张单
        const href = githubIssueLink(item);
        if (href) window.open(href, '_blank', 'noreferrer');
        return;
      }
      navigate(n.data.kind === 'ask' ? '/notifications' : item.link);
    },
    [navigate, remote],
  );
  const focusOn = useCallback(
    (id: string) => {
      select(id);
      setFocusMode(true);
    },
    [select],
  );

  const selectedExists = Boolean(selectedId && graph.nodes.some((n) => n.id === selectedId));
  const focus = useMemo(
    () => (focusMode && selectedId && selectedExists ? lineage(graph, selectedId) : null),
    [focusMode, selectedId, selectedExists, graph],
  );

  // 选中和聚焦走小仓库（见 board-ui.tsx），不进上下文：换选中时只有前后两张卡重画。
  useLayoutEffect(() => {
    view.set(selectedId, focus);
  }, [view, selectedId, focus]);

  const ui = useMemo(() => ({ view, remote, select, open, focusOn }), [view, remote, select, open, focusOn]);

  // 推送一来主页就重拉，但多数卡片没变：沿用上一轮的节点对象，React Flow 和卡片组件就都不重画它们。
  const nodeCache = useRef(new Map<string, BoardNode>());
  const nodes = useMemo<BoardNode[]>(() => {
    const prev = nodeCache.current;
    const next = new Map<string, BoardNode>();
    for (const n of graph.nodes) {
      const p = positions?.get(n.id);
      if (!p) continue;
      const old = prev.get(n.id);
      const node: BoardNode =
        old && old.position === p && sameNodeData(old.data, n.data)
          ? old
          : {
              id: n.id,
              type: n.data.kind,
              data: n.data,
              position: p,
              width: n.width,
              height: n.height,
              draggable: false,
              selectable: false,
              connectable: false,
              focusable: false,
            };
      next.set(n.id, node);
    }
    nodeCache.current = next;
    return [...next.values()];
  }, [graph, positions]);

  const motion = useReducedMotion();
  const edgeCache = useRef(new Map<string, { key: string; edge: Edge }>());
  const edges = useMemo<Edge[]>(() => {
    const prev = edgeCache.current;
    const next = new Map<string, { key: string; edge: Edge }>();
    // 流动的虚线每条都要逐帧重绘：条数多了就只画成静止的虚线；「减少动效」打开时一条都不动。
    const animate = !motion && graph.edges.filter((e) => e.live).length <= MAX_ANIMATED_EDGES;
    for (const e of graph.edges) {
      const dim = focus ? !(focus.has(e.source) && focus.has(e.target)) : false;
      const fromRoot = e.source === ROOT_ID;
      const key = `${e.source}|${e.target}|${e.side}|${e.tone}|${e.live}|${dim}|${fromRoot}|${animate}`;
      const old = prev.get(e.id);
      next.set(e.id, old && old.key === key ? old : { key, edge: toEdge(e, { dim, fromRoot, animate }) });
    }
    edgeCache.current = next;
    return [...next.values()].map((x) => x.edge);
  }, [graph, focus, motion]);

  const center = useCallback(
    (id: string, zoom?: number) => {
      const p = positions?.get(id);
      const n = graphRef.current.nodes.find((x) => x.id === id);
      if (!p || !n) return;
      void rf.setCenter(p.x + n.width / 2, p.y + n.height / 2, { zoom: zoom ?? rf.getZoom(), duration: 280 });
    },
    [positions, rf],
  );

  const zoomToLevel = useCallback(
    (level: ZoomLevel) => {
      const cur = selRef.current;
      if (cur && graphRef.current.nodes.some((n) => n.id === cur)) center(cur, ZOOM_OF[level]);
      else void rf.zoomTo(ZOOM_OF[level], { duration: 320 });
    },
    [center, rf],
  );

  const toggleStuck = useCallback(() => setParam('stuck', stuck ? null : '1'), [stuck, setParam]);
  const toggleNeedsYou = useCallback(() => setParam('you', needsYou ? null : '1'), [needsYou, setParam]);
  const clearFilters = useCallback(
    () =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.delete('stuck');
          p.delete('you');
          return p;
        },
        { replace: true, preventScrollReset: true },
      ),
    [setParams],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const interactive = el !== e.currentTarget && el.closest('button, a, [role="menuitem"]');
    const key = e.key;
    const cur = selRef.current;
    const sel = cur ? graph.nodes.find((n) => n.id === cur) : undefined;
    if (key.startsWith('Arrow')) {
      if (!positions) return;
      e.preventDefault();
      const next = neighbour(graph, positions, sel ? sel.id : null, key);
      if (next) {
        select(next);
        center(next);
      }
      return;
    }
    switch (key) {
      case 'Escape':
        if (focusMode) setFocusMode(false);
        else select(null);
        return;
      case 'Enter':
        if (interactive) return;
        if (!sel) select(graph.nodes[0]?.id ?? null);
        return;
      case 'o':
      case 'O':
        if (sel) open(sel.id);
        return;
      case 'f':
      case 'F':
        if (sel) setFocusMode((v) => !v);
        return;
      case 's':
      case 'S':
        toggleStuck();
        return;
      case 'y':
      case 'Y':
        toggleNeedsYou();
        return;
      case '1':
        zoomToLevel('far');
        return;
      case '2':
        zoomToLevel('mid');
        return;
      case '3':
        zoomToLevel('near');
        return;
      case '0':
        fitAll();
        return;
      case '+':
      case '=':
        void rf.zoomIn({ duration: 200 });
        return;
      case '-':
        void rf.zoomOut({ duration: 200 });
        return;
      case '?':
        setHelp(true);
        return;
    }
    if (!sel) return;
    const item = itemOf(sel.data);
    const target = item ? targetOfItem(item, remote) : undefined;
    if (!target) return;
    const hit = shortcutAction(target, key);
    if (hit) {
      e.preventDefault();
      trigger(hit, target);
    }
  };

  const selectedData = selectedExists ? graph.nodes.find((n) => n.id === selectedId)?.data : undefined;

  return (
    <BoardUiContext value={ui}>
      <div className="relative h-full w-full" data-flow-board>
        <div
          ref={wrapper}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 画布要拿到焦点才能全键盘操作，按键说明见「?」。
          tabIndex={0}
          role="application"
          aria-label="在跑的单的看板：方向键在卡片间移动，Enter 看详情，? 看全部快捷键"
          onKeyDown={onKeyDown}
          onPointerDown={() => wrapper.current?.focus({ preventScroll: true })}
          className="relative h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => select(n.id)}
            onNodeDoubleClick={(_, n) => open(n.id)}
            onPaneClick={() => select(null)}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            disableKeyboardA11y
            zoomOnDoubleClick={false}
            zoomOnScroll={false}
            preventScrolling={false}
            onlyRenderVisibleElements={graph.nodes.length > VISIBLE_ONLY_ABOVE}
            minZoom={0.15}
            maxZoom={2.4}
            attributionPosition="bottom-center"
            className={cn(positions && 'fd-board-ready')}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--grid)" />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeBorderRadius={6}
              nodeStrokeWidth={0}
              nodeColor={(n) => toneVar[toneOfData(n.data as BoardNodeData)]}
              ariaLabel="小地图"
              className="hidden! xl:block!"
            />
          </ReactFlow>
          <Toolbar
            stuck={stuck}
            needsYou={needsYou}
            focusMode={focusMode}
            canFocus={selectedExists}
            onToggleStuck={toggleStuck}
            onToggleNeedsYou={toggleNeedsYou}
            onFocus={() => setFocusMode((v) => !v)}
            onZoomLevel={zoomToLevel}
            onFit={() => fitAll()}
            onHelp={() => setHelp(true)}
            shown={graph.shown}
            total={graph.total}
          />
          <NowPanel
            running={running}
            onPick={(id) => {
              select(id);
              center(id);
            }}
          />
          {!positions && !layoutError ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">
              正在排版…
            </div>
          ) : null}
          {layoutError ? (
            <LayoutFailed
              error={layoutError}
              blank={!positions}
              onRetry={() => {
                setLayoutError(null);
                setLayoutTry((n) => n + 1);
              }}
            />
          ) : null}
          {graph.shown === 0 && graph.total > 0 && positions ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="pointer-events-auto rounded-xl border bg-popover px-5 py-4 text-center shadow-lg">
                <div className="text-sm font-medium">{emptyFilterCopy(stuck, needsYou)}</div>
                <Button size="sm" variant="link" onClick={clearFilters}>
                  清掉过滤条件
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <AnimatePresence>
          {selectedData ? (
            <DetailPanel
              key="detail"
              data={selectedData}
              running={running}
              onClose={() => select(null)}
              onSelect={(id) => {
                select(id);
                center(id);
              }}
            />
          ) : null}
        </AnimatePresence>
        <ShortcutsDialog open={help} onOpenChange={setHelp} />
      </div>
    </BoardUiContext>
  );
}

/** 排版没成：一次都没排成时在画布正中说；排成过（画面是之前的）就在工具条下面压一条。 */
function LayoutFailed({ error, blank, onRetry }: { error: Error; blank: boolean; onRetry(): void }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 z-20 flex justify-center px-3',
        blank ? 'inset-y-0 items-center' : 'top-16',
      )}
    >
      <div
        role="alert"
        className="pointer-events-auto flex max-w-xl items-center gap-2 rounded-lg border border-st-fail/40 bg-popover px-3 py-2 text-xs shadow-lg"
      >
        <TriangleAlert className="size-3.5 shrink-0 text-ink-fail" aria-hidden />
        <span className="min-w-0">
          <span className="font-medium text-ink-fail">看板排版没成</span>
          <span className="text-muted-foreground">
            ：{error.message}。{blank ? '画布先空着，' : '下面是上一次排好的画面，'}可以重试。
          </span>
        </span>
        <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={onRetry}>
          重试
        </Button>
      </div>
    </div>
  );
}

// ---------- 顶部工具条 ----------

function ToolButton({
  label,
  tip,
  shortcut,
  active,
  onClick,
  children,
  disabled,
}: {
  label: string;
  /** 悬停说明。不传就用 label。 */
  tip?: string;
  shortcut?: string;
  active?: boolean;
  onClick(): void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={active}
          aria-label={tip ? `${label}：${tip}` : label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'h-8 gap-1.5 px-2.5 text-sub',
            active && 'bg-foreground text-background hover:bg-foreground/90 hover:text-background',
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {tip ?? label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

function emptyFilterCopy(stuck: boolean, needsYou: boolean): string {
  if (stuck && needsYou) return '没有出问题的单，也没有等你拍的单';
  if (stuck) return '没有出问题的单（不含等你）';
  return '没有等你拍的单';
}

function Toolbar({
  stuck,
  needsYou,
  focusMode,
  canFocus,
  onToggleStuck,
  onToggleNeedsYou,
  onFocus,
  onZoomLevel,
  onFit,
  onHelp,
  shown,
  total,
}: {
  stuck: boolean;
  needsYou: boolean;
  focusMode: boolean;
  canFocus: boolean;
  onToggleStuck(): void;
  onToggleNeedsYou(): void;
  onFocus(): void;
  onZoomLevel(l: ZoomLevel): void;
  onFit(): void;
  onHelp(): void;
  shown: number;
  total: number;
}) {
  const level = useZoomLevel();
  const rf = useReactFlow();
  const levels: { id: ZoomLevel; label: string; key: string; hint: string }[] = [
    { id: 'far', label: '远', key: '1', hint: '远景：色块、单号和标题' },
    { id: 'mid', label: '中', key: '2', hint: '中景：标题、在哪一段、谁在做' },
    { id: 'near', label: '近', key: '3', hint: '近景：在等什么、最近一次事件、耗时' },
  ];
  return (
    <div
      data-board-toolbar
      className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2"
    >
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-popover/90 p-1 shadow-sm backdrop-blur">
        <ToolButton
          label="只看卡住的"
          tip="出问题了（不含等你）"
          shortcut="S"
          active={stuck}
          onClick={onToggleStuck}
        >
          <TriangleAlert className="size-3.5" />
          只看卡住的
        </ToolButton>
        <ToolButton
          label="只看等你的"
          tip="等你拍（不含出问题）"
          shortcut="Y"
          active={needsYou}
          onClick={onToggleNeedsYou}
        >
          <MessageCircleQuestion className="size-3.5" />
          只看等你的
        </ToolButton>
        <span className="mx-0.5 h-5 w-px bg-border" />
        <ToolButton
          label={canFocus ? '聚焦选中的这一支，其余变暗' : '先选中一张卡再聚焦'}
          shortcut="F"
          active={focusMode}
          disabled={!canFocus && !focusMode}
          onClick={onFocus}
        >
          <Focus className="size-3.5" />
          聚焦
        </ToolButton>
      </div>

      <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-popover/90 p-1 shadow-sm backdrop-blur">
        {levels.map((l) => (
          <ToolButton
            key={l.id}
            label={l.hint}
            shortcut={l.key}
            active={level === l.id}
            onClick={() => onZoomLevel(l.id)}
          >
            {l.label}
          </ToolButton>
        ))}
        <span className="mx-0.5 h-5 w-px bg-border" />
        <ToolButton label="缩小" shortcut="-" onClick={() => void rf.zoomOut({ duration: 200 })}>
          <Minus className="size-3.5" />
        </ToolButton>
        <ToolButton label="放大" shortcut="+" onClick={() => void rf.zoomIn({ duration: 200 })}>
          <Plus className="size-3.5" />
        </ToolButton>
        <ToolButton label="全部收进视野" shortcut="0" onClick={onFit}>
          <Maximize className="size-3.5" />
        </ToolButton>
      </div>

      <div className="pointer-events-auto ml-auto flex items-center gap-0.5 rounded-xl border bg-popover/90 p-1 shadow-sm backdrop-blur">
        <span className="px-2 text-xs text-muted-foreground">
          <span className="num text-foreground">{shown}</span>
          {shown !== total ? (
            <>
              {' '}
              / <span className="num">{total}</span>
            </>
          ) : null}{' '}
          张单
        </span>
        <Legend />
        <ToolButton label="键盘快捷键" shortcut="?" onClick={onHelp}>
          <Keyboard className="size-3.5" />
        </ToolButton>
      </div>
    </div>
  );
}

const LEGEND: { tone: Tone; label: string; meaning: string }[] = [
  { tone: 'run', label: toneLabel.run, meaning: '对题、动手、验收正常往前走' },
  { tone: 'wait', label: toneLabel.wait, meaning: '排队、等额度、等合并队列' },
  { tone: 'stall', label: '还没验', meaning: '动手收了、验收还没起，不是失败' },
  { tone: 'human', label: toneLabel.human, meaning: '等你拍板（要你拍的那块里有它）' },
  { tone: 'fail', label: '出问题', meaning: '最近一次是超时、失败或没起来' },
];

function Legend() {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="h-8 px-2.5" aria-label="颜色图例">
              <Palette className="size-3.5" />
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>颜色图例</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80">
        <div className="mb-2 text-xs text-muted-foreground">看板上颜色只表达状态：</div>
        <ul className="space-y-1.5">
          {LEGEND.map((t) => (
            <li key={t.tone} className="flex items-center gap-2 text-sub">
              <StatusDot tone={t.tone} />
              <span className="w-12 font-medium">{t.label}</span>
              <span className="text-xs text-muted-foreground">{t.meaning}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// ---------- 此刻：哪个模型正在干哪张单 ----------

function NowPanel({ running, onPick }: { running: readonly HomeRunning[]; onPick(id: string): void }) {
  // 矮屏（笔记本）默认收起，只留一行，免得盖住卡片；点开过、收起过就记住这个选择。
  const tall = useMediaQuery('(min-height: 940px)');
  const [stored, setStored] = useLocalState<boolean | null>(
    `${brand.storagePrefix}home-board.now-open`,
    null,
  );
  const open = stored ?? tall;
  const rows = running
    .filter((r) => r.worker !== undefined || r.waitingReason === 'queue')
    .map((r) => ({ item: r, queued: r.worker === undefined }))
    .sort(
      (a, b) =>
        Number(a.queued) - Number(b.queued) ||
        (a.item.stageSince ?? a.item.waitingSince ?? '').localeCompare(
          b.item.stageSince ?? b.item.waitingSince ?? '',
        ),
    );
  const working = rows.filter((r) => !r.queued).length;
  const queued = rows.length - working;
  return (
    <div
      data-board-now
      className="pointer-events-auto absolute bottom-3 left-3 z-10 w-96 max-w-full overflow-hidden rounded-xl border bg-popover/92 shadow-lg backdrop-blur"
    >
      <button
        type="button"
        onClick={() => setStored(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sub font-medium"
        aria-expanded={open}
      >
        <StatusDot tone={working ? 'run' : 'wait'} />
        此刻
        <span className="text-muted-foreground">
          <span className="num">{working}</span> 个会话在干活
          {queued ? (
            <>
              {' '}
              · <span className="num">{queued}</span> 张在排队
            </>
          ) : null}
        </span>
        <ChevronDown
          className={cn('ml-auto size-4 text-muted-foreground transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && rows.length ? (
        <ul className="max-h-56 overflow-y-auto border-t py-1">
          {rows.map((r) => (
            <NowRow key={nodeId.ticket(r.item)} item={r.item} queued={r.queued} onPick={onPick} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 此刻一行。状态可以换行；右边耗时是原来的分钟列，留出列宽并且不换行。 */
function NowRow({ item, queued, onPick }: { item: HomeRunning; queued: boolean; onPick(id: string): void }) {
  const now = useNow();
  const since = queued ? item.waitingSince : item.stageSince;
  const elapsed = since ? formatDuration(Math.max(0, now - Date.parse(since))) : '';
  const status = statusTextOf(item);
  const full = [status, item.title, elapsed].filter((part) => part !== '').join(' · ');
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(nodeId.ticket(item))}
        title={full}
        className={cn(
          'flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent',
          queued && 'text-muted-foreground',
        )}
      >
        <span className="num w-22 shrink-0 truncate font-medium" title={item.worker ?? '排队'}>
          {item.worker ?? '排队'}
        </span>
        <span className="num shrink-0 text-muted-foreground">#{item.issueNumber}</span>
        <span className="min-w-0 flex-1 whitespace-normal break-words text-muted-foreground" title={full}>
          {status} · {item.title}
        </span>
        <span
          className="num min-w-24 shrink-0 text-right whitespace-nowrap text-muted-foreground"
          title={elapsed || undefined}
        >
          {elapsed}
        </span>
      </button>
    </li>
  );
}

// ---------- 快捷键说明 ----------

const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ['←', '→', '↑', '↓'], what: '在卡片之间移动：左右是上下级，上下是同一层' },
  { keys: ['Enter'], what: '选中中心 / 看详情' },
  { keys: ['O'], what: '打开选中单子的详情页（同双击）' },
  { keys: ['Esc'], what: '退出聚焦 / 取消选中' },
  { keys: ['F'], what: '聚焦选中的这一支，其余变暗' },
  { keys: ['S'], what: '只看卡住的（出问题了，不含等你）' },
  { keys: ['Y'], what: '只看等你的（等你拍，不含出问题）' },
  { keys: ['1', '2', '3'], what: '远景 / 中景 / 近景' },
  { keys: ['+', '-', '0'], what: '放大 / 缩小 / 全部收进视野' },
  { keys: ['Ctrl', '滚轮'], what: '缩放（不按 Ctrl 滚轮是滚页面）' },
  { keys: ['C', 'X'], what: '继续 / 叫停（对选中的单）' },
  { keys: ['R'], what: '重做（已叫停或挂起的单）' },
  { keys: ['⌘', 'K'], what: '命令面板：跳页面、找任务、切主题' },
];

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Hand className="size-4" />
            看板快捷键
          </DialogTitle>
          <DialogDescription>
            鼠标能做的，键盘都能做。先点一下画布，或按 Tab 把焦点放到画布上。
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y">
          {SHORTCUTS.map((s) => (
            <li key={s.what} className="flex items-center gap-3 py-2 text-sm">
              <span className="flex w-36 shrink-0 flex-wrap gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
              <span className="text-muted-foreground">{s.what}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
