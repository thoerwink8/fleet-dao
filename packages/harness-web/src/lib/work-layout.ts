// 波次图的布局（#3784）：波＝列。把每个节点所在的波号当 elk 的分区号（partition），layered 算法按分区从左到右排层，
// 同一波的节点落在同一列，边的交叉由 elk 去最小化（OmO 自己写了 4 轮重心扫描，我们直接用 elk，见 PR「参照了什么」）。
// 卡片大小是固定的，所以布局只依赖「哪些节点画出来、各占多大、有哪些边」，状态变化不会重排。
import type { WorkEdge } from '@fleet-dao/harness-contract/work-graph';
import type { WaveView } from './work-model';

export const CARD_W = 224;
export const CARD_H = 96;
export const COMPACT_H = 30;
export const MORE_H = 36;
export const GAP_Y = 12;
export const GAP_X = 64;
/** 列头（第 N 波）占的高度，节点从它下面开始排。 */
export const HEAD_H = 40;

export interface PlacedNode {
  id: string;
  kind: 'node' | 'more';
  wave: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedWave {
  index: number;
  x: number;
  w: number;
}

export interface Layout {
  nodes: PlacedNode[];
  waves: PlacedWave[];
  width: number;
  height: number;
}

export const moreId = (wave: number): string => `more:${wave}`;

interface Sized {
  id: string;
  kind: 'node' | 'more';
  wave: number;
  w: number;
  h: number;
}

/** 要画的格子：每一波的节点（折叠后的）依次排，折叠了就接一个「+N 更多」格。 */
export function sizedNodes(views: readonly WaveView[]): Sized[] {
  const out: Sized[] = [];
  for (const v of views) {
    for (const id of v.shown) {
      out.push({ id, kind: 'node', wave: v.index, w: CARD_W, h: v.compact ? COMPACT_H : CARD_H });
    }
    if (v.foldable) out.push({ id: moreId(v.index), kind: 'more', wave: v.index, w: CARD_W, h: MORE_H });
  }
  return out;
}

/** 喂给 elk 的图（纯数据，单测直接看）。 */
export function buildElkGraph(views: readonly WaveView[], edges: readonly WorkEdge[]) {
  const sized = sizedNodes(views);
  const ids = new Set(sized.map((s) => s.id));
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.partitioning.activate': 'true',
      'elk.spacing.nodeNode': String(GAP_Y),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(GAP_X),
      'elk.layered.spacing.edgeNodeBetweenLayers': '16',
      // 没有边的节点不要被当成一个个独立的小图重新摆成网格；同一列里保持给定的顺序（「+N 更多」永远在最后）
      'elk.separateConnectedComponents': 'false',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: sized.map((s) => ({
      id: s.id,
      width: s.w,
      height: s.h,
      layoutOptions: { 'elk.partitioning.partition': String(s.wave) },
    })),
    edges: edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
}

function finish(sized: readonly Sized[], pos: Map<string, { x: number; y: number }>): Layout {
  const nodes: PlacedNode[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = 0;
  let maxY = 0;
  for (const s of sized) {
    const p = pos.get(s.id) ?? { x: 0, y: 0 };
    nodes.push({ ...s, x: p.x, y: p.y + HEAD_H });
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + s.w);
    maxY = Math.max(maxY, p.y + s.h + HEAD_H);
  }
  if (nodes.length === 0) return { nodes, waves: [], width: 0, height: 0 };
  const shift = -minX;
  for (const n of nodes) n.x += shift;
  const byWave = new Map<number, PlacedNode[]>();
  for (const n of nodes) byWave.set(n.wave, [...(byWave.get(n.wave) ?? []), n]);
  const waves = [...byWave.entries()]
    .map(([index, list]) => {
      const x = Math.min(...list.map((n) => n.x));
      return { index, x, w: Math.max(...list.map((n) => n.x + n.w)) - x };
    })
    .sort((a, b) => a.index - b.index);
  return { nodes, waves, width: maxX + shift, height: maxY };
}

/** 不用 elk 的退路（elk 加载不了或算崩了）：一波一列，列内自上而下。 */
export function fallbackLayout(views: readonly WaveView[]): Layout {
  const sized = sizedNodes(views);
  const pos = new Map<string, { x: number; y: number }>();
  const colY = new Map<number, number>();
  const order = views.map((v) => v.index);
  for (const s of sized) {
    const y = colY.get(s.wave) ?? 0;
    pos.set(s.id, { x: order.indexOf(s.wave) * (CARD_W + GAP_X), y });
    colY.set(s.wave, y + s.h + GAP_Y);
  }
  return finish(sized, pos);
}

type ElkLike = { layout(g: unknown): Promise<{ children?: { id: string; x?: number; y?: number }[] }> };
let elkPromise: Promise<ElkLike> | null = null;
/** elk 比较大，画布页第一次打开时才加载（单独一块）。 */
function loadElk(): Promise<ElkLike> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => {
    const Elk = (m as unknown as { default: new () => ElkLike }).default;
    return new Elk();
  });
  return elkPromise;
}

export async function layoutGraph(views: readonly WaveView[], edges: readonly WorkEdge[]): Promise<Layout> {
  const sized = sizedNodes(views);
  if (sized.length === 0) return finish(sized, new Map());
  try {
    const elk = await loadElk();
    const res = await elk.layout(buildElkGraph(views, edges));
    const pos = new Map<string, { x: number; y: number }>();
    for (const c of res.children ?? []) pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
    if (pos.size !== sized.length) throw new Error('elk 没给全位置');
    return finish(sized, pos);
  } catch {
    return fallbackLayout(views);
  }
}
