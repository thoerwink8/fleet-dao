// 用 ELK 把任务树排成思维导图：仓在中间，右边一棵向右展开、左边一棵向左展开，最后把两边的根对齐。
// 浏览器里 ELK 跑在 Web Worker 里（elkjs 自带的 elk-worker），排版再久也不卡页面；
// 没有 Worker 的环境（单元测试）退回同线程的打包版。elkjs 约 1.5 MB，用到时才加载。
import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { Graph, Side } from './model';

let elkPromise: Promise<ELK> | undefined;

function getElk(): Promise<ELK> {
  elkPromise ??=
    typeof Worker === 'undefined'
      ? import('elkjs/lib/elk.bundled.js').then((m) => new m.default())
      : import('elkjs/lib/elk-api.js').then((m) => new m.default({ workerUrl: elkWorkerUrl }));
  return elkPromise;
}

export type Positions = Map<string, { x: number; y: number }>;

/**
 * 分层按「离源头多远」（LONGEST_PATH_SOURCE）：图是一棵树，这就等于深度，是线性的；
 * 默认的网络单纯形分层在 100 个需求 × 5 个子任务上要 3 秒，结果却一模一样。
 * 连线由 React Flow 自己画，ELK 算出的线型不用。
 */
function options(direction: 'RIGHT' | 'LEFT'): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'SPLINES',
    'elk.layered.layering.strategy': 'LONGEST_PATH_SOURCE',
    'elk.layered.spacing.nodeNodeBetweenLayers': '84',
    'elk.spacing.nodeNode': '20',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    // 保持数据里的先后（需求按优先级排好了），不让算法为了少交叉而打乱。
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  };
}

async function layoutSide(elk: ELK, graph: Graph, rootId: string, side: Side): Promise<Positions> {
  const ids = new Set(graph.nodes.filter((n) => n.side === side).map((n) => n.id));
  ids.add(rootId);
  const input: ElkNode = {
    id: `root-${side}`,
    layoutOptions: options(side === 'right' ? 'RIGHT' : 'LEFT'),
    children: graph.nodes
      .filter((n) => ids.has(n.id))
      .map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: graph.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const out = await elk.layout(input);
  const pos: Positions = new Map();
  for (const c of out.children ?? []) pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return pos;
}

// 同一套节点排过一次就记住：来回切「只看卡住的」时第二次不用再算。
const cache = new Map<string, Positions>();
const CACHE_SIZE = 8;

export async function layoutGraph(graph: Graph): Promise<Positions> {
  const hit = cache.get(graph.structureKey);
  if (hit) return hit;
  const elk = await getElk();
  const root = graph.nodes[0];
  if (!root) return new Map();
  const hasLeft = graph.nodes.some((n) => n.side === 'left');
  const [right, left] = await Promise.all([
    layoutSide(elk, graph, root.id, 'right'),
    hasLeft ? layoutSide(elk, graph, root.id, 'left') : Promise.resolve(undefined),
  ]);
  let merged: Positions = right;
  if (left) {
    const r = right.get(root.id) ?? { x: 0, y: 0 };
    const l = left.get(root.id) ?? { x: 0, y: 0 };
    const dx = r.x - l.x;
    const dy = r.y - l.y;
    merged = new Map(right);
    for (const [id, p] of left) if (id !== root.id) merged.set(id, { x: p.x + dx, y: p.y + dy });
  }
  cache.set(graph.structureKey, merged);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return merged;
}
