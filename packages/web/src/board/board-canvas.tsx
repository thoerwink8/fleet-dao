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
} from '@xyflow/react';
import {
  ChevronDown,
  Focus,
  Hand,
  Keyboard,
  Maximize,
  Minus,
  Palette,
  Plus,
  TriangleAlert,
  User,
} from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useRouting } from '../api/client';
import type { Board, Me, NowItem } from '../api/types';
import { StatusDot } from '../components/status';
import { ACTIONS, availableActions, useTaskActions } from '../components/task-actions';
import { useTheme } from '../components/theme-provider';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Kbd } from '../components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { formatDuration } from '../lib/format';
import { useLocalState, useMediaQuery, useTimeText } from '../lib/hooks';
import { letterOf, subtaskTone, TONES, type Tone, taskTone, toneLabel, toneVar } from '../lib/status';
import { cn } from '../lib/utils';
import {
  BoardUiContext,
  createBoardView,
  hrefOf,
  nodeTarget,
  useZoomLevel,
  ZOOM_OF,
  type ZoomLevel,
} from './board-ui';
import { DetailPanel } from './detail-panel';
import { layoutGraph, type Positions } from './layout';
import { type BoardNodeData, buildGraph, type Graph, type GraphEdge, lineage, nodeId } from './model';
import { type BoardNode, nodeTypes, prState } from './nodes';

export function BoardCanvas(props: { board: Board; me: Me | undefined }) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

/** 同时流动的连线上限：再多就改成静止虚线（中景帧率的主要开销，见 PR #13 的压测）。 */
const MAX_ANIMATED_EDGES = 60;
/** 节点多于这个数时只渲染视野里的卡片和连线：中景、近景一屏只有几十张，没必要让几百张一起挂在页面上。 */
const VISIBLE_ONLY_ABOVE = 150;

/** 两份节点数据是否画出来一样：需求、子任务对象靠 React Query 的结构共享，没变就是同一个对象。 */
export function sameNodeData(a: BoardNodeData, b: BoardNodeData): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case 'repo':
      return (
        b.kind === 'repo' &&
        a.repo === b.repo &&
        a.counts.running === b.counts.running &&
        a.counts.stuck === b.counts.stuck &&
        a.counts.human === b.counts.human &&
        a.counts.done === b.counts.done &&
        a.counts.total === b.counts.total
      );
    case 'task':
      return b.kind === 'task' && a.task === b.task && a.side === b.side;
    case 'sub':
      return (
        b.kind === 'sub' && a.sub === b.sub && a.task === b.task && a.side === b.side && a.letter === b.letter
      );
    case 'pr':
      return (
        b.kind === 'pr' &&
        a.sub === b.sub &&
        a.task === b.task &&
        a.side === b.side &&
        a.letter === b.letter &&
        a.prNumber === b.prNumber
      );
  }
}

function toEdge(e: GraphEdge, o: { dim: boolean; fromRoot: boolean; animate: boolean }): Edge {
  const colored = e.tone === 'run' || e.tone === 'stall' || e.tone === 'fail' || e.tone === 'human';
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    // 仓节点左右各一个接头。
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
    case 'task':
      return taskTone(d.task);
    case 'sub':
      return subtaskTone(d.sub);
    case 'pr':
      return prState(d.sub).tone;
    default:
      return 'wait';
  }
}

/**
 * 方向键按画面方向走：往外（远离仓）是子节点，往里是父节点；上下在同一层、同一侧里按纵向位置走。
 * 右半边「→」是往外，左半边「←」是往外；在仓上按「→ / ←」进右边 / 左边。
 */
function neighbour(graph: Graph, pos: Positions, current: string | null, key: string): string | null {
  const root = graph.nodes[0]?.id ?? null;
  const node = current ? graph.nodes.find((n) => n.id === current) : undefined;
  if (!node || !current) return root;
  const y = (id: string) => pos.get(id)?.y ?? 0;
  const nearestKid = (kids: string[]) => {
    if (!kids.length) return null;
    // 挑纵向离自己最近的孩子，视线不用跳。
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

function Canvas({ board, me }: { board: Board; me: Me | undefined }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const stuck = params.get('stuck') === '1';
  const mine = params.get('mine') === '1';
  const selectedId = params.get('sel');
  const [focusMode, setFocusMode] = useState(false);
  const [help, setHelp] = useState(false);
  const { data: routing } = useRouting();
  const { trigger } = useTaskActions();
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [view] = useState(createBoardView);

  const graph = useMemo(
    () => buildGraph(board, { stuck, mine: mine && me ? [me.user.id, me.user.displayName] : null }),
    [board, stuck, mine, me],
  );
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const [positions, setPositions] = useState<Positions | null>(null);
  const structureKey = graph.structureKey;
  const viewKey = `${board.repo.id}|${stuck}|${mine}`;
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
   * 全部收进视野。位置和尺寸都是自己排的、已知的，直接按它们算，不等 React Flow 量卡片：
   * 它的 fitView 要等卡片量完才生效，盘面不动时会拖好几秒才收。
   */
  const fitAll = useCallback(
    (duration = 400) => {
      const el = wrapper.current;
      if (!positions || !el) return;
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
      const box = el.getBoundingClientRect();
      const bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      // 让开浮在画布上的东西：顶上的工具条，左下的「此刻」，右下的小地图。
      // 左下右下两块要么从底边让（压矮），要么从两侧让（压窄）——哪样放得大用哪样。
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

  // 换仓或换过滤条件后，排好版再整体收进视野一次；之后不乱动用户的视角。
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
        { replace: true },
      ),
    [setParams],
  );

  // 选中项记在网址里（?sel=），但换网址是过渡更新，盘面一直在动时会比下一次按键晚提交；
  // 键盘连按以这里记的为准，不然第二下会从旧的选中项算起。
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
      if (n) navigate(hrefOf(n.data));
    },
    [navigate],
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

  const ui = useMemo(
    () => ({ view, routing, me, select, open, focusOn }),
    [view, routing, me, select, open, focusOn],
  );

  // 推送一来看板就重拉，但多数卡片没变：沿用上一轮的节点对象，React Flow 和卡片组件就都不重画它们。
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
    // 流动的虚线每条都要逐帧重绘：条数多了（一两百条）中景掉到二三十帧。超过上限就只画成静止的虚线，
    // 「在跑」照样看得出来；「减少动效」打开时一条都不动。
    const animate = !motion && graph.edges.filter((e) => e.live).length <= MAX_ANIMATED_EDGES;
    for (const e of graph.edges) {
      const dim = focus ? !(focus.has(e.source) && focus.has(e.target)) : false;
      const fromRoot = !graph.parentOf.has(e.source);
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
      rf.setCenter(p.x + n.width / 2, p.y + n.height / 2, { zoom: zoom ?? rf.getZoom(), duration: 280 });
    },
    [positions, rf],
  );

  const zoomToLevel = useCallback(
    (level: ZoomLevel) => {
      const cur = selRef.current;
      if (cur && graphRef.current.nodes.some((n) => n.id === cur)) center(cur, ZOOM_OF[level]);
      else rf.zoomTo(ZOOM_OF[level], { duration: 320 });
    },
    [center, rf],
  );

  const toggleParam = useCallback(
    (key: 'stuck' | 'mine') => setParam(key, params.get(key) === '1' ? null : '1'),
    [params, setParam],
  );

  useEffect(() => {
    wrapper.current?.focus({ preventScroll: true });
  }, []);

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
        toggleParam('stuck');
        return;
      case 'i':
      case 'I':
        toggleParam('mine');
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
        rf.zoomIn({ duration: 200 });
        return;
      case '-':
        rf.zoomOut({ duration: 200 });
        return;
      case '?':
        setHelp(true);
        return;
    }
    if (!sel) return;
    const target = nodeTarget(sel.data);
    if (!target) return;
    const hit = availableActions(target).find((a) => ACTIONS[a].key === key.toUpperCase());
    if (hit) {
      e.preventDefault();
      trigger(hit, target);
    }
  };

  const selectedData = selectedExists ? graph.nodes.find((n) => n.id === selectedId)?.data : undefined;
  const shownTasks = graph.nodes.filter((n) => n.data.kind === 'task').length;

  return (
    <BoardUiContext value={ui}>
      <div className="relative h-full w-full">
        <div
          ref={wrapper}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 画布要拿到焦点才能全键盘操作，按键说明见「?」。
          tabIndex={0}
          role="application"
          aria-label="看板画布：方向键在卡片间移动，Enter 看详情，? 看全部快捷键"
          onKeyDown={onKeyDown}
          className="relative h-full w-full outline-none"
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
              className="hidden! lg:block!"
            />
          </ReactFlow>
          <Toolbar
            stuck={stuck}
            mine={mine}
            focusMode={focusMode}
            canFocus={selectedExists}
            onToggle={toggleParam}
            onFocus={() => setFocusMode((v) => !v)}
            onZoomLevel={zoomToLevel}
            onFit={() => fitAll()}
            onHelp={() => setHelp(true)}
            shown={shownTasks}
            total={board.tasks.length}
          />
          <NowPanel
            board={board}
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
          {shownTasks === 0 && positions ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="pointer-events-auto rounded-xl border bg-popover px-5 py-4 text-center shadow-lg">
                <div className="text-sm font-medium">{stuck ? '没有卡住的需求' : '没有符合条件的需求'}</div>
                <Button size="sm" variant="link" onClick={() => setParams({}, { replace: true })}>
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
              board={board}
              routing={routing}
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
  shortcut,
  active,
  onClick,
  children,
  disabled,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick(): void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'h-8 gap-1.5 px-2.5 text-[13px]',
            active && 'bg-foreground text-background hover:bg-foreground/90 hover:text-background',
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

function Toolbar({
  stuck,
  mine,
  focusMode,
  canFocus,
  onToggle,
  onFocus,
  onZoomLevel,
  onFit,
  onHelp,
  shown,
  total,
}: {
  stuck: boolean;
  mine: boolean;
  focusMode: boolean;
  canFocus: boolean;
  onToggle(k: 'stuck' | 'mine'): void;
  onFocus(): void;
  onZoomLevel(l: ZoomLevel): void;
  onFit(): void;
  onHelp(): void;
  shown: number;
  total: number;
}) {
  const level = useZoomLevel();
  const rf = useReactFlow();
  const levels: { id: ZoomLevel; label: string; key: string }[] = [
    { id: 'far', label: '远', key: '1' },
    { id: 'mid', label: '中', key: '2' },
    { id: 'near', label: '近', key: '3' },
  ];
  return (
    <div
      data-board-toolbar
      className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2"
    >
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-popover/90 p-1 shadow-sm backdrop-blur">
        <ToolButton
          label="只看卡住的：等人、停滞、失败"
          shortcut="S"
          active={stuck}
          onClick={() => onToggle('stuck')}
        >
          <TriangleAlert className="size-3.5" />
          只看卡住的
        </ToolButton>
        <ToolButton label="只看我提的" shortcut="I" active={mine} onClick={() => onToggle('mine')}>
          <User className="size-3.5" />
          只看我提的
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
            label={
              l.id === 'far'
                ? '远景：只看色块和数字'
                : l.id === 'mid'
                  ? '中景：文字和按钮'
                  : '近景：每一步的路由、耗时、状态'
            }
            shortcut={l.key}
            active={level === l.id}
            onClick={() => onZoomLevel(l.id)}
          >
            {l.label}
          </ToolButton>
        ))}
        <span className="mx-0.5 h-5 w-px bg-border" />
        <ToolButton label="缩小" shortcut="-" onClick={() => rf.zoomOut({ duration: 200 })}>
          <Minus className="size-3.5" />
        </ToolButton>
        <ToolButton label="放大" shortcut="+" onClick={() => rf.zoomIn({ duration: 200 })}>
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
          个需求
        </span>
        <Legend />
        <ToolButton label="键盘快捷键" shortcut="?" onClick={onHelp}>
          <Keyboard className="size-3.5" />
        </ToolButton>
      </div>
    </div>
  );
}

const toneMeaning = {
  run: '在跑：分诊、写方案、写码、验证、合并中',
  wait: '在等：排队、等空位、等前一个子任务',
  human: '等你：回答追问',
  stall: '停滞：一段时间没进展，已交帅位',
  fail: '失败：测试没过或出错，等重试',
  done: '完成：已合并 / 已关单',
  stop: '叫停：人叫停的',
} as const;

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
      <PopoverContent align="end" className="w-72">
        <div className="mb-2 text-xs text-muted-foreground">看板上颜色只表达状态：</div>
        <ul className="space-y-1.5">
          {TONES.map((t) => (
            <li key={t} className="flex items-center gap-2 text-[13px]">
              <StatusDot tone={t} />
              <span className="w-8 font-medium">{toneLabel[t]}</span>
              <span className="text-xs text-muted-foreground">{toneMeaning[t].split('：')[1]}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// ---------- 此刻：哪个模型正在干哪个任务 ----------

/** 「此刻」一行：点了跳到对应的卡片。卡片被过滤掉了就跳到需求卡。 */
function nowRow(board: Board, item: NowItem) {
  const task = board.tasks.find((t) => t.id === item.taskId);
  const sub = item.subtaskId ? task?.subtasks.find((s) => s.id === item.subtaskId) : undefined;
  return {
    item,
    nodeId: sub ? nodeId.sub(sub.id) : nodeId.task(item.taskId),
    label: task ? `#${task.issueNumber}${sub ? ` ${letterOf(sub.index)}` : ''}` : '',
    what: item.step ?? sub?.title ?? item.taskTitle,
  };
}

function NowPanel({ board, onPick }: { board: Board; onPick(id: string): void }) {
  // 矮屏（笔记本）默认收起，只留一行，免得盖住卡片；点开过、收起过就记住这个选择。
  const tall = useMediaQuery('(min-height: 940px)');
  const [stored, setStored] = useLocalState<boolean | null>('fleet-dao.board.now-open', null);
  const open = stored ?? tall;
  const rows = board.now
    .map((n) => nowRow(board, n))
    .sort(
      (a, b) => Number(a.item.queued) - Number(b.item.queued) || a.item.since.localeCompare(b.item.since),
    );
  const working = rows.filter((r) => !r.item.queued).length;
  const queued = rows.length - working;
  return (
    <div
      data-board-now
      className="pointer-events-auto absolute bottom-3 left-3 z-10 w-[360px] max-w-[calc(100%-24px)] overflow-hidden rounded-xl border bg-popover/92 shadow-lg backdrop-blur"
    >
      <button
        type="button"
        onClick={() => setStored(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium"
        aria-expanded={open}
      >
        <StatusDot tone={working ? 'run' : 'wait'} />
        此刻
        <span className="text-muted-foreground">
          <span className="num">{working}</span> 个会话在干活
          {queued ? (
            <>
              {' '}
              · <span className="num">{queued}</span> 个在排队
            </>
          ) : null}
        </span>
        <ChevronDown
          className={cn('ml-auto size-4 text-muted-foreground transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && rows.length ? (
        <ul className="max-h-56 overflow-y-auto border-t py-1 scrollbar-thin">
          {rows.map((r) => (
            <li key={r.item.runId}>
              <button
                type="button"
                onClick={() => onPick(r.nodeId)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent',
                  r.item.queued && 'text-muted-foreground',
                )}
              >
                <span className="num w-[86px] shrink-0 truncate font-medium">{r.item.modelName}</span>
                <span className="num shrink-0 text-muted-foreground">{r.label}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.what}</span>
                <span className="num shrink-0 text-muted-foreground">
                  {r.item.queued ? '排 ' : ''}
                  <NowElapsed since={r.item.since} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function NowElapsed({ since }: { since: string }) {
  return <>{useTimeText((now) => formatDuration(now - Date.parse(since)))}</>;
}

// ---------- 快捷键说明 ----------

const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ['←', '→', '↑', '↓'], what: '在卡片之间移动：左右是上下级，上下是同一层' },
  { keys: ['Enter'], what: '选中根节点 / 看详情' },
  { keys: ['O'], what: '打开选中卡片的后台页（同双击）' },
  { keys: ['Esc'], what: '退出聚焦 / 取消选中' },
  { keys: ['F'], what: '聚焦选中的这一支，其余变暗' },
  { keys: ['S'], what: '只看卡住的' },
  { keys: ['I'], what: '只看我提的' },
  { keys: ['1', '2', '3'], what: '远景 / 中景 / 近景' },
  { keys: ['+', '-', '0'], what: '放大 / 缩小 / 全部收进视野' },
  { keys: ['M', 'A'], what: '换模型 / 回答追问' },
  { keys: ['P', 'C', 'X'], what: '暂停 / 继续 / 叫停（对整个需求）' },
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
