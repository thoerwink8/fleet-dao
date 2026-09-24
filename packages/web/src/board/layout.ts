// 用 ELK 把任务树排成思维导图：仓在中间，右边一棵向右展开、左边一棵向左展开，最后把两边的根对齐。
// elkjs 打包后约 1.5 MB，用到时才加载。
import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import type { Graph, Side } from './model';

let elkPromise: Promise<ELK> | undefined;

function getElk(): Promise<ELK> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return elkPromise;
}

export type Positions = Map<string, { x: number; y: number }>;

function options(direction: 'RIGHT' | 'LEFT'): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'SPLINES',
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

export async function layoutGraph(graph: Graph): Promise<Positions> {
  const elk = await getElk();
  const root = graph.nodes[0];
  if (!root) return new Map();
  const hasLeft = graph.nodes.some((n) => n.side === 'left');
  const right = await layoutSide(elk, graph, root.id, 'right');
  if (!hasLeft) return right;
  const left = await layoutSide(elk, graph, root.id, 'left');
  const r = right.get(root.id) ?? { x: 0, y: 0 };
  const l = left.get(root.id) ?? { x: 0, y: 0 };
  const dx = r.x - l.x;
  const dy = r.y - l.y;
  const merged: Positions = new Map(right);
  for (const [id, p] of left) if (id !== root.id) merged.set(id, { x: p.x + dx, y: p.y + dy });
  return merged;
}
