// 首页「在跑的」思维导图：引擎 → 三段（对题 / 动手 / 验收）→ 每张单 →（等你拍的那件事）。
// 只管「有哪些节点、谁连谁、颜色和左右」，位置交给 layout.ts（ELK）。纯函数，测试直接喂 /api/home 的数据。
//
// 来历：初版看板（PR #13：React Flow + ELK 两侧展开、三级缩放、聚焦、过滤、全键盘）在 #613 删掉；
// 创始人 2026-10-07「react-flow 我还是喜欢初版那样」，按初版的样子和手感重做，数据换成现在的三段流水（/api/home）。
// 改这里之前必须知道：
// - 「还没验」（verify_pending）不是失败：颜色走 stall 黄系，不进「卡住的」过滤；红只留给最近一次事件是 trouble 的单。
// - 推不出在哪一段的单（segment=null）挂在「还没分段」下面，只有真有这样的单才出现这一支，不拿空节点占地方。
// - 三段节点永远在（哪怕这一段 0 张）：它们是流程本身；过滤只藏单子，不藏段。
// - 单子节点编号 ticket:<单号>:<owner/name>（e2e 按这个前缀数单子）。
import { laneOf, type SegmentKind } from '@fleet-dao/shared';
import type { Tone } from '../../../lib/status';
import { needsFounder, toneOf } from '../running-card';
import type { HomeFlowStage, HomeHealth, HomeRunning } from '../types';

export type SegmentKey = SegmentKind | 'none';
export const SEGMENT_KEYS: readonly SegmentKey[] = ['scope', 'manual', 'verify', 'none'];

export type NodeKind = 'root' | 'segment' | 'ticket' | 'ask';

/** 思维导图两边展开：引擎在中间，三段分到左右两侧。 */
export type Side = 'left' | 'right';

export interface ToneCounts {
  /** 有模型在跑 / 正常往前走。 */
  run: number;
  /** 排队、等额度、等合并队列。 */
  wait: number;
  /** 动手收了、验收还没起（不是失败）。 */
  stall: number;
  /** 等你拍。 */
  human: number;
  /** 最近一次事件是超时 / 失败 / 没起来。 */
  fail: number;
  total: number;
}

export type BoardNodeData =
  | { kind: 'root'; counts: ToneCounts; engine: HomeHealth['engine'] | undefined; repos: string[] }
  | {
      kind: 'segment';
      key: SegmentKey;
      stage: HomeFlowStage | undefined;
      counts: ToneCounts;
      /** 过滤之前这一段一共几张（过滤藏掉的照样算在「在途」里）。 */
      total: number;
      side: Side;
    }
  | { kind: 'ticket'; item: HomeRunning; key: SegmentKey; side: Side }
  | { kind: 'ask'; item: HomeRunning; text: string; side: Side };

/** 节点尺寸固定：三级缩放只换内容不换大小，拉近拉远时排版不跳。 */
export const NODE_SIZE: Record<NodeKind, { width: number; height: number }> = {
  root: { width: 264, height: 148 },
  segment: { width: 256, height: 148 },
  ticket: { width: 304, height: 184 },
  ask: { width: 216, height: 76 },
};

export interface GraphNode {
  id: string;
  data: BoardNodeData;
  width: number;
  height: number;
  /** 根节点没有边、没有左右。 */
  side?: Side;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  tone: Tone;
  live: boolean;
  side: Side;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  parentOf: Map<string, string>;
  childrenOf: Map<string, string[]>;
  /** 节点集合的指纹：只有它变了才重新排版，状态变化（颜色、文字）不动位置。 */
  structureKey: string;
  /** 过滤后画出来的单子数 / 一共的单子数。 */
  shown: number;
  total: number;
}

export interface BoardFilter {
  /** 只看卡住的：等你拍、出问题了。 */
  stuck: boolean;
}

export const ROOT_ID = 'root';

export const nodeId = {
  segment: (key: SegmentKey) => `segment:${key}`,
  ticket: (item: Pick<HomeRunning, 'issueNumber' | 'repo'>) => `ticket:${item.issueNumber}:${item.repo}`,
  ask: (item: Pick<HomeRunning, 'issueNumber' | 'repo'>) => `ask:${item.issueNumber}:${item.repo}`,
};

export function segmentKeyOf(item: HomeRunning): SegmentKey {
  return laneOf(item.segment) ?? 'none';
}

/** 卡片颜色：和原来的卡片同一个判法（running-card.tsx 的 toneOf）。 */
export function ticketTone(item: HomeRunning): Tone {
  return toneOf(item).tone;
}

/** 卡片要不要「呼吸」：这一刻真有模型在跑，而且正常往前走。 */
export function ticketLive(item: HomeRunning): boolean {
  return item.worker !== undefined && ticketTone(item) === 'run';
}

/** 卡住的 = 要人管的：等你拍、出问题了。还没验、排队不算（是正常的等）。 */
export function isStuck(item: HomeRunning): boolean {
  const tone = ticketTone(item);
  return tone === 'human' || tone === 'fail';
}

export function countTones(items: readonly HomeRunning[]): ToneCounts {
  const c: ToneCounts = { run: 0, wait: 0, stall: 0, human: 0, fail: 0, total: items.length };
  for (const it of items) {
    const tone = ticketTone(it);
    if (tone === 'run' || tone === 'wait' || tone === 'stall' || tone === 'human' || tone === 'fail')
      c[tone] += 1;
  }
  return c;
}

/** 一组单子里最要紧的颜色：等你 > 出问题 > 在跑 > 还没验 > 在等。三段节点和连线用它。 */
export function worstTone(c: ToneCounts): Tone {
  if (c.human) return 'human';
  if (c.fail) return 'fail';
  if (c.run) return 'run';
  if (c.stall) return 'stall';
  return 'wait';
}

/** 一段里单子的先后：等你拍的 → 出问题的 → 本段待得久的 → 单号。最该看的在最上面。 */
export function compareTickets(a: HomeRunning, b: HomeRunning): number {
  const rank = (it: HomeRunning): [number, number, number] => {
    const since = it.stageSince ? Date.parse(it.stageSince) : Number.NaN;
    return [
      needsFounder(it) ? 0 : 1,
      it.lastEvent?.tone === 'trouble' ? 0 : 1,
      Number.isFinite(since) ? since : Number.POSITIVE_INFINITY,
    ];
  };
  const ra = rank(a);
  const rb = rank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.issueNumber - b.issueNumber;
}

export interface SegmentGroup {
  key: SegmentKey;
  stage: HomeFlowStage | undefined;
  /** 过滤后、排好序的单子。 */
  items: HomeRunning[];
  /** 过滤前这一段一共几张。 */
  total: number;
}

/** 按段分组：三段固定先后；「还没分段」只在真有这样的单时才有。 */
export function groupSegments(
  running: readonly HomeRunning[],
  flow: readonly HomeFlowStage[],
  filter: BoardFilter,
): SegmentGroup[] {
  const keys = SEGMENT_KEYS.filter((k) => k !== 'none' || running.some((r) => segmentKeyOf(r) === 'none'));
  return keys.map((key) => {
    const all = running.filter((r) => segmentKeyOf(r) === key);
    return {
      key,
      stage: key === 'none' ? undefined : flow.find((f) => f.segment === key),
      items: all.filter((r) => !filter.stuck || isStuck(r)).sort(compareTickets),
      total: all.length,
    };
  });
}

/** 一段在画布上占几行高：空的段也占一行。 */
function rowsOf(g: SegmentGroup): number {
  return Math.max(1, g.items.length);
}

/**
 * 按先后切成两半、两边高度尽量相等：前面的段在右边（从上往下读），后面的在左边。
 * 切点挑两边行数差最小的那个；一样小就让右边多。只有一段时全在右边。
 */
export function splitSides(groups: readonly SegmentGroup[]): Map<SegmentKey, Side> {
  const rows = groups.map(rowsOf);
  const total = rows.reduce((a, b) => a + b, 0);
  let best = groups.length;
  let bestDiff = Number.POSITIVE_INFINITY;
  let acc = 0;
  for (let i = 1; i <= groups.length; i++) {
    acc += rows[i - 1] ?? 0;
    // 至少一段在右边；能分就别让左边空着（两段以上时）
    if (groups.length > 1 && i === groups.length) break;
    const diff = Math.abs(acc - (total - acc));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  const sides = new Map<SegmentKey, Side>();
  groups.forEach((g, i) => {
    sides.set(g.key, i < best ? 'right' : 'left');
  });
  return sides;
}

export function buildGraph(input: {
  running: readonly HomeRunning[];
  flow: readonly HomeFlowStage[];
  health?: HomeHealth | undefined;
  filter: BoardFilter;
}): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();

  const add = (
    id: string,
    data: BoardNodeData,
    parent?: { id: string; side: Side; tone: Tone; live: boolean },
  ) => {
    const node: GraphNode = { id, data, ...NODE_SIZE[data.kind] };
    if (parent) node.side = parent.side;
    nodes.push(node);
    if (!parent) return;
    parentOf.set(id, parent.id);
    childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), id]);
    edges.push({
      id: `${parent.id}->${id}`,
      source: parent.id,
      target: id,
      side: parent.side,
      tone: parent.tone,
      live: parent.live,
    });
  };

  const repos = [...new Set(input.running.map((r) => r.repo))].sort();
  add(ROOT_ID, {
    kind: 'root',
    counts: countTones(input.running),
    engine: input.health?.engine,
    repos,
  });

  const groups = groupSegments(input.running, input.flow, input.filter);
  const sides = splitSides(groups);
  let shown = 0;
  for (const g of groups) {
    const side = sides.get(g.key) ?? 'right';
    const sid = nodeId.segment(g.key);
    const all = input.running.filter((r) => segmentKeyOf(r) === g.key);
    const counts = countTones(all);
    add(
      sid,
      { kind: 'segment', key: g.key, stage: g.stage, counts, total: g.total, side },
      { id: ROOT_ID, side, tone: worstTone(counts), live: all.some(ticketLive) },
    );
    for (const item of g.items) {
      shown += 1;
      const tid = nodeId.ticket(item);
      const tone = ticketTone(item);
      add(tid, { kind: 'ticket', item, key: g.key, side }, { id: sid, side, tone, live: ticketLive(item) });
      if (item.pendingDecision !== undefined) {
        add(
          nodeId.ask(item),
          { kind: 'ask', item, text: item.pendingDecision, side },
          { id: tid, side, tone: 'human', live: false },
        );
      }
    }
  }

  const structureKey = nodes.map((n) => `${n.id}@${n.side ?? 'root'}`).join('|');
  return { nodes, edges, parentOf, childrenOf, structureKey, shown, total: input.running.length };
}

export interface Phase {
  key: 'scope' | 'manual' | 'verify' | 'merge';
  label: string;
  state: 'done' | 'active' | 'pending';
  tone: Tone;
}

const PHASES: readonly { key: Phase['key']; label: string }[] = [
  { key: 'scope', label: '对题' },
  { key: 'manual', label: '动手' },
  { key: 'verify', label: '验收' },
  { key: 'merge', label: '合并' },
];

/**
 * 卡片底下的迷你时间线（初版的 PhaseStrip）：对题 → 动手 → 验收 → 合并，走过的实心、正在的那段上状态色、没到的淡。
 * 推不出在哪一段（segment=null）的：四段都画成没到，不猜。
 */
export function phasesOf(item: HomeRunning): Phase[] {
  const at: Record<NonNullable<HomeRunning['segment']>, number> = {
    scoping: 0,
    doing: 1,
    verify_pending: 2,
    verifying: 2,
    merge: 3,
  };
  const current = item.segment === null ? -1 : at[item.segment];
  const tone = ticketTone(item);
  return PHASES.map((p, i) => ({
    ...p,
    label: i === 2 && item.segment === 'verify_pending' ? '还没验' : p.label,
    state: current < 0 || i > current ? 'pending' : i < current ? 'done' : 'active',
    tone: i < current ? 'done' : tone,
  }));
}

/** 选中一个节点时要保持明亮的集合：它自己、所有祖先、所有后代。 */
export function lineage(graph: Graph, id: string): Set<string> {
  const keep = new Set<string>([id]);
  let p = graph.parentOf.get(id);
  while (p) {
    keep.add(p);
    p = graph.parentOf.get(p);
  }
  const stack = [...(graph.childrenOf.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop() as string;
    keep.add(c);
    stack.push(...(graph.childrenOf.get(c) ?? []));
  }
  return keep;
}
