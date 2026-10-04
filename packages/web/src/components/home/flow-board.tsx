// 主页「在跑的」：三段流水线图。三条泳道（对题 → 动手 → 验收）横排，每张开着的单是一张卡落在它现在所在的那一段；
// 泳道头上写这一段在途几张、近期平均耗时。布局由 lib/home-flow-layout.ts 算死，不许拖散；缩放、平移留着（宽屏上卡多时看得清）。
//
// 为什么用 react-flow（创始人 2026-10-05 问「首页的 react-flow 怎么没了」，母单 #902）：它给了现成的平移 / 缩放 / 边上的流动动画，
// 节点和边就是「泳道 → 泳道」这个流程本身。代价（体积、构建时间）实测写在 #902 的 PR 里。
// 改这里之前必须知道：
// - 节点必须带死的 width / height：react-flow 量不到尺寸的节点会先隐藏，测试环境（happy-dom）里就全是空的。
// - 卡片里的链接要 pointer-events-auto：不可拖、不可选的节点外壳默认 pointer-events:none，点不进去。
// - 滚轮不缩放、不拦页面滚动（zoomOnScroll / preventScrolling）：首页要能往下滚到「做完的」。

import {
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatDuration } from '../../lib/format';
import { buildFlowLayout, type FlowNodeData, HEADER_H, type LaneInfo, PAD } from '../../lib/home-flow-layout';
import { SEGMENT_UNMETERED, segmentHint, segmentLabel } from '../../lib/segments';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { RunningCard } from './running-card';
import type { HomeFlowStage, HomeRunning } from './types';

type LaneNode = Node<Extract<FlowNodeData, { kind: 'lane' }>, 'lane'>;
type TicketNode = Node<Extract<FlowNodeData, { kind: 'ticket' }>, 'ticket'>;
type MoreNode = Node<Extract<FlowNodeData, { kind: 'more' }>, 'more'>;

/** 窗口天数写在 flow 的说明里：api 的样本取看板窗口（近 7 天进终态的 + 开着的）。 */
const SAMPLE_DAYS = 7;

function avgText(stage: HomeFlowStage | undefined, lane: LaneInfo['key']): string {
  if (!stage) return '不在三段里，没有耗时';
  // 不计的段（对题，#761）没样本是常态不是「还没有」；有样本（引擎起的会话）照常给平均
  if (stage.avgMs === undefined) {
    const unmetered = lane === 'none' ? undefined : SEGMENT_UNMETERED[lane];
    return unmetered ? `${unmetered.short}耗时` : '还没有跑完的样本';
  }
  return `平均 ${formatDuration(stage.avgMs)} · ${stage.samples} 笔`;
}

const LaneView = memo(function LaneView({ data }: NodeProps<LaneNode>) {
  const lane: LaneInfo = data.lane;
  const total = lane.items.length + lane.hidden.length;
  const laneKey = lane.key;
  return (
    <div data-flow-lane={lane.key} className="h-full w-full rounded-xl border bg-muted/40">
      <div className="flex flex-col justify-center gap-1 px-4" style={{ height: HEADER_H - PAD }}>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-label font-semibold">
            {laneKey === 'none' ? '还没分段' : segmentLabel[laneKey]}
          </h3>
          <span className="num text-stat-num font-semibold leading-none" title={`在途 ${total} 张`}>
            {total}
            <span className="ml-1 text-xs font-normal text-muted-foreground">张在途</span>
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {laneKey === 'none' ? 'runs 里没有流水可推出在哪一段' : segmentHint[laneKey]}
        </p>
        <p
          className="num truncate text-xs text-muted-foreground"
          title={`样本取近 ${SAMPLE_DAYS} 天看板窗口里跑完的`}
        >
          {avgText(lane.stage, laneKey)}
        </p>
      </div>
      {total === 0 ? <p className="px-4 pt-4 text-xs text-muted-foreground">这一段现在没有单</p> : null}
      {data.stacked ? (
        <>
          <Handle type="target" position={Position.Top} />
          <Handle type="source" position={Position.Bottom} />
        </>
      ) : (
        <>
          <Handle type="target" position={Position.Left} style={{ top: HEADER_H / 2 }} />
          <Handle type="source" position={Position.Right} style={{ top: HEADER_H / 2 }} />
        </>
      )}
    </div>
  );
});

const TicketView = memo(function TicketView({ data }: NodeProps<TicketNode>) {
  return <RunningCard item={data.item} />;
});

const MoreView = memo(function MoreView({ data }: NodeProps<MoreNode>) {
  return (
    <div className="pointer-events-auto nopan nodrag grid h-full place-items-center rounded-lg border border-dashed text-xs text-muted-foreground">
      还有 <span className="num">{data.count}</span> 张没摆下（上面是最该看的）
    </div>
  );
});

// 放在组件外面：react-flow 要求 nodeTypes 引用稳定，否则每次重画都当成换了节点类型。
const nodeTypes = { lane: LaneView, ticket: TicketView, more: MoreView };

/**
 * 量容器宽度（ResizeObserver）。第一次量在画面画出来之前（useLayoutEffect）：画布要等量到了才挂上去，
 * 否则它先按退路宽度排一遍、视口被 react-flow 居中到一个错的位置，后面容器变宽也不会自己回正（#902 D9：验收泳道被右边挤掉一截）。
 * 量不到（没有排版：测试环境宽度恒为 0、没有这个 API）退回 fallback，不当 0。
 */
function useElementWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ width: number; measured: boolean }>({
    width: fallback,
    measured: false,
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      setState((prev) => ({ width: w > 0 ? w : prev.width, measured: true }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width: state.width, measured: state.measured };
}

function Legend() {
  const dot = (cls: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2 rounded-full', cls)} aria-hidden />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {dot('bg-st-run', '在跑')}
      {dot('bg-st-wait', '在等')}
      {dot('bg-st-stall', '还没验')}
      {dot('bg-st-human', '等你拍')}
      {dot('bg-st-fail', '出问题了')}
    </div>
  );
}

function Toolbar() {
  const rf = useReactFlow();
  const reset = useCallback(() => void rf.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 }), [rf]);
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="缩小"
        onClick={() => void rf.zoomOut()}
      >
        <Minus />
      </Button>
      <Button type="button" size="icon-xs" variant="ghost" aria-label="放大" onClick={() => void rf.zoomIn()}>
        <Plus />
      </Button>
      <Button type="button" size="icon-xs" variant="ghost" aria-label="复位" onClick={reset}>
        <Maximize2 />
      </Button>
    </div>
  );
}

/** 容器宽度、横竖排变了就把视口放回原点：react-flow 只在用户拖动时才按新的范围收视口，不放回会留着旧的偏移。 */
function ViewportHome({ width, stacked }: { width: number; stacked: boolean }) {
  const rf = useReactFlow();
  // biome-ignore lint/correctness/useExhaustiveDependencies: width、stacked 变了就要回原点，不读它们的值
  useEffect(() => {
    void rf.setViewport({ x: 0, y: 0, zoom: 1 });
  }, [rf, width, stacked]);
  return null;
}

const FALLBACK_WIDTH = 1200;

export function FlowBoard({
  running,
  flow,
  className,
}: {
  running: readonly HomeRunning[];
  flow: readonly HomeFlowStage[];
  className?: string;
}) {
  const { ref, width, measured } = useElementWidth(FALLBACK_WIDTH);
  const layout = useMemo(() => buildFlowLayout(running, flow, width), [running, flow, width]);
  const stacked = layout.stacked === true;
  const nodes = useMemo<Node[]>(
    () =>
      layout.nodes.map(
        (n): Node => ({
          id: n.id,
          type: n.type,
          position: n.position,
          width: n.width,
          height: n.height,
          zIndex: n.zIndex,
          data: n.data,
          draggable: false,
          selectable: false,
          connectable: false,
          focusable: false,
        }),
      ),
    [layout],
  );
  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.animated,
        selectable: false,
        focusable: false,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [layout],
  );
  return (
    <ReactFlowProvider>
      <div className={cn('flex flex-col', className)} data-flow-board>
        <div className="flex items-center justify-between gap-3 px-4 py-2">
          <Legend />
          {stacked ? null : <Toolbar />}
        </div>
        <div
          ref={ref}
          style={{ height: layout.height }}
          className={cn('border-t', stacked && 'fd-flow-stacked')}
          data-flow-stacked={stacked}
        >
          {measured ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              minZoom={0.6}
              maxZoom={1.6}
              translateExtent={[
                [0, 0],
                [layout.width, layout.height],
              ]}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              zoomOnScroll={false}
              zoomOnDoubleClick={false}
              zoomOnPinch={!stacked}
              preventScrolling={false}
              panOnDrag={!stacked}
            >
              <ViewportHome width={layout.width} stacked={stacked} />
            </ReactFlow>
          ) : null}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
