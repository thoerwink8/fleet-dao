// 任务波次图的纯函数（#3784）：波的校验与回退、折叠、紧凑卡、活跃波、上下游闭包、用时、状态配色。
// 思路借 OmO 桌面端的画布（出处和取舍见 PR 描述「参照了什么」）：波以服务端给的为准，校验不过再自己推；
// 一波太大时折叠；打开时对准「当前活跃波」；悬停时只亮上下游。这里不碰 DOM，也不碰 elk，单测直接喂数据。
import {
  isSettled,
  type WorkEdge,
  type WorkGraph,
  type WorkNode,
  type WorkWave,
} from '@fleet-dao/harness-contract/work-graph';

/** 一波超过这么多个节点就折叠，只画前 WAVE_SHOWN 个，后面接一个「+N 更多」格。 */
export const WAVE_FOLD_ABOVE = 13;
export const WAVE_SHOWN = 12;
/** 一波有这么多个节点起用紧凑卡（一行：点 + 名字 + 状态）。 */
export const COMPACT_FROM = 16;

export type Tone = 'running' | 'success' | 'danger' | 'warning' | 'muted';

/** 状态 → 配色档：在跑蓝、做完绿、失败红、阻塞和暂停黄、其余灰。不认识的状态当灰。 */
export function toneOf(state: string): Tone {
  switch (state) {
    case 'running':
      return 'running';
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'blocked':
    case 'paused':
      return 'warning';
    default:
      return 'muted';
  }
}

// ---- 波 ----

export type WaveRepair = 'missing-from-waves' | 'backward-edge' | 'cycle';

export interface ResolvedWaves {
  waves: WorkWave[];
  /** 服务端给的波没通过校验、已经自己推算时写原因；通过了是 null。顶栏据此提示「波信息缺失，已自动推算」。 */
  repaired: WaveRepair | null;
}

/** 自己推波：波＝依赖的最长深度；有环的节点放进最后一波。节点按给定顺序。 */
function inferWaves(
  nodes: readonly WorkNode[],
  edges: readonly WorkEdge[],
): { waves: WorkWave[]; cyclic: boolean } {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  const depth = new Map<string, number>();
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    for (const to of out.get(id) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 0, (depth.get(id) ?? 0) + 1));
      indeg.set(to, (indeg.get(to) ?? 1) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  const cyclic = depth.size < nodes.length;
  const last = depth.size === 0 ? 0 : Math.max(...depth.values()) + (cyclic ? 1 : 0);
  const byDepth = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? last;
    byDepth.set(d, [...(byDepth.get(d) ?? []), n.id]);
  }
  const waves = [...byDepth.keys()]
    .sort((a, b) => a - b)
    .map((d, index) => ({ index, nodeIds: byDepth.get(d) as string[] }));
  return { waves, cyclic };
}

/**
 * 波以服务端给的为准；每个节点必须恰好出现在一个波里、依赖不许指向同波或更后的波，
 * 不满足就退回自己推并写明原因。
 */
export function resolveWaves(graph: Pick<WorkGraph, 'nodes' | 'waves' | 'edges'>): ResolvedWaves {
  const waveOf = new Map<string, number>();
  let dup = false;
  for (const w of graph.waves) {
    for (const id of w.nodeIds) {
      if (waveOf.has(id)) dup = true;
      waveOf.set(id, w.index);
    }
  }
  const missing = dup || graph.nodes.some((n) => !waveOf.has(n.id));
  if (!missing) {
    const backward = graph.edges.some((e) => {
      const a = waveOf.get(e.from);
      const b = waveOf.get(e.to);
      return a !== undefined && b !== undefined && a >= b;
    });
    if (!backward) {
      const known = new Set(graph.nodes.map((n) => n.id));
      const waves = graph.waves
        .map((w) => ({ index: w.index, nodeIds: w.nodeIds.filter((id) => known.has(id)) }))
        .filter((w) => w.nodeIds.length > 0)
        .sort((a, b) => a.index - b.index);
      return { waves, repaired: null };
    }
    const inferred = inferWaves(graph.nodes, graph.edges);
    return { waves: inferred.waves, repaired: inferred.cyclic ? 'cycle' : 'backward-edge' };
  }
  const inferred = inferWaves(graph.nodes, graph.edges);
  return { waves: inferred.waves, repaired: inferred.cyclic ? 'cycle' : 'missing-from-waves' };
}

/** 当前活跃波：第一个还有没结束节点的波（waves 里的下标）；全结束了就是最后一波，没有波是 0。 */
export function activeWavePos(waves: readonly WorkWave[], nodes: readonly WorkNode[]): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pos = waves.findIndex((w) => w.nodeIds.some((id) => !isSettled(byId.get(id)?.state ?? 'pending')));
  return pos >= 0 ? pos : Math.max(0, waves.length - 1);
}

export interface WaveView {
  index: number;
  /** 这一波全部节点。 */
  all: string[];
  /** 画出来的节点（折叠且没展开时只有前 WAVE_SHOWN 个）。 */
  shown: string[];
  /** 被折叠起来的个数（0 = 没折叠，或者已展开）。 */
  more: number;
  /** 紧凑卡：一波有 COMPACT_FROM 个以上。 */
  compact: boolean;
  /** 能折叠（节点数超过 WAVE_FOLD_ABOVE）：展开后还要能收回去。 */
  foldable: boolean;
}

export function viewWaves(waves: readonly WorkWave[], expanded: ReadonlySet<number>): WaveView[] {
  return waves.map((w) => {
    const foldable = w.nodeIds.length > WAVE_FOLD_ABOVE;
    const folded = foldable && !expanded.has(w.index);
    const shown = folded ? w.nodeIds.slice(0, WAVE_SHOWN) : w.nodeIds;
    return {
      index: w.index,
      all: w.nodeIds,
      shown,
      more: w.nodeIds.length - shown.length,
      compact: w.nodeIds.length >= COMPACT_FROM,
      foldable,
    };
  });
}

// ---- 高亮 ----

/** 一个节点的上下游传递闭包（含自己）。没有边时只有自己。 */
export function relatedIds(id: string, edges: readonly WorkEdge[]): Set<string> {
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const e of edges) {
    down.set(e.from, [...(down.get(e.from) ?? []), e.to]);
    up.set(e.to, [...(up.get(e.to) ?? []), e.from]);
  }
  const out = new Set<string>([id]);
  for (const adj of [up, down]) {
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const next of adj.get(cur) ?? []) {
        if (!out.has(next)) {
          out.add(next);
          stack.push(next);
        }
      }
    }
  }
  return out;
}

/** 状态的「糟糕程度」：边按上游里最糟的着色（在跑 > 失败 > 阻塞 > 取消 > 排队 > 跳过 > 做完）。 */
const WORST_ORDER = [
  'running',
  'failed',
  'blocked',
  'paused',
  'cancelled',
  'scheduled',
  'pending',
  'skipped',
  'completed',
];
export function worstState(states: readonly string[]): string {
  let best = 'completed';
  let rank = WORST_ORDER.length;
  for (const s of states) {
    const r = WORST_ORDER.indexOf(s);
    const rr = r < 0 ? WORST_ORDER.length - 2 : r;
    if (rr < rank) {
      rank = rr;
      best = s;
    }
  }
  return best;
}

// ---- 用时 ----

/** 这个节点现在的用时：在跑算到 now，结束了算开始到结束；没开始是 null。 */
export function elapsedMs(
  node: Pick<WorkNode, 'state' | 'startedAt' | 'completedAt'>,
  now: number,
): number | null {
  if (!node.startedAt) return null;
  const start = Date.parse(node.startedAt);
  if (Number.isNaN(start)) return null;
  if (isSettled(node.state)) {
    const end = node.completedAt ? Date.parse(node.completedAt) : Number.NaN;
    return Number.isNaN(end) ? null : Math.max(0, end - start);
  }
  if (node.state === 'running' || node.state === 'blocked') return Math.max(0, now - start);
  return null;
}

/** 卡片上的用时：3 秒 / 4 分 05 秒 / 1 时 02 分。 */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(m / 60)} 时 ${String(m % 60).padStart(2, '0')} 分`;
}

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** 同一张单重试过：当前是第几次尝试超过 1，或者跑过不止一次。 */
export const retried = (n: Pick<WorkNode, 'attempt' | 'runIds'>): boolean =>
  n.attempt > 1 || n.runIds.length > 1;
export const retryCount = (n: Pick<WorkNode, 'attempt' | 'runIds'>): number =>
  Math.max(n.attempt, n.runIds.length);

/** 窄屏列表的排序：失败、卡住的在前，在跑次之，排队暂停再后，做完在最后。 */
const LIST_RANK: Record<string, number> = {
  failed: 0,
  blocked: 1,
  running: 2,
  paused: 3,
  scheduled: 4,
  pending: 5,
  completed: 6,
  cancelled: 7,
  skipped: 8,
};
export const listRank = (state: string): number => LIST_RANK[state] ?? 5;
