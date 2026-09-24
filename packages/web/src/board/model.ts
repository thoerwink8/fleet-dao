// 看板的图：仓 → 需求 → 子任务 → PR。只管「有哪些节点、谁连谁」，位置交给 layout.ts。
import type { Board, BoardSubtask, BoardTask, Repo } from '../api/types';
import {
  isTaskClosed,
  letterOf,
  needsAttention,
  subLive,
  subtaskTone,
  type Tone,
  taskLive,
  taskTone,
} from '../lib/status';

export type NodeKind = 'repo' | 'task' | 'sub' | 'pr';

export interface RepoCounts {
  running: number;
  stuck: number;
  human: number;
  done: number;
  total: number;
}

/** 思维导图两边展开：仓在中间，需求分到左右两侧。 */
export type Side = 'left' | 'right';

export type BoardNodeData =
  | { kind: 'repo'; repo: Repo; counts: RepoCounts }
  | { kind: 'task'; task: BoardTask; side: Side }
  | { kind: 'sub'; sub: BoardSubtask; task: BoardTask; letter: string; side: Side }
  | { kind: 'pr'; prNumber: number; sub: BoardSubtask; task: BoardTask; letter: string; side: Side };

/** 节点尺寸固定：三级缩放只换内容不换大小，拉近拉远时排版不跳。 */
export const NODE_SIZE: Record<NodeKind, { width: number; height: number }> = {
  repo: { width: 248, height: 140 },
  task: { width: 304, height: 208 },
  sub: { width: 280, height: 188 },
  pr: { width: 180, height: 68 },
};

export interface GraphNode {
  id: string;
  data: BoardNodeData;
  width: number;
  height: number;
  /** 仓节点没有边。 */
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
  /** 节点集合的指纹：只有它变了才重新排版，状态变化不动位置。 */
  structureKey: string;
}

export interface BoardFilter {
  /** 只看卡住的：等人、停滞、失败。 */
  stuck: boolean;
  /** 只看我提的：requestedBy 等于这里任何一个（用户编号或名字）。 */
  mine: readonly string[] | null;
}

export const nodeId = {
  repo: (id: string) => `repo:${id}`,
  task: (id: string) => `task:${id}`,
  sub: (id: string) => `sub:${id}`,
  pr: (subId: string) => `pr:${subId}`,
};

export function repoCounts(tasks: BoardTask[]): RepoCounts {
  let running = 0;
  let stuck = 0;
  let human = 0;
  let done = 0;
  for (const t of tasks) {
    const tone = taskTone(t);
    if (tone === 'run') running += 1;
    if (tone === 'stall' || tone === 'fail') stuck += 1;
    if (tone === 'human') human += 1;
    if (tone === 'done') done += 1;
  }
  return { running, stuck, human, done, total: tasks.length };
}

export function filterTasks(tasks: BoardTask[], filter: BoardFilter): BoardTask[] {
  return tasks.filter((t) => {
    if (filter.stuck && !needsAttention(t)) return false;
    if (filter.mine && !filter.mine.includes(t.requestedBy)) return false;
    return true;
  });
}

/** 一个需求在画布上占几行高：收起的占一行，展开的按子任务数。 */
function rowsOf(t: BoardTask): number {
  return isTaskClosed(t) ? 1 : Math.max(1, t.subtasks.length);
}

/**
 * 按优先级顺序切成两半、两边高度尽量相等：先做的在右边（从上往下读），其余在左边。
 * 这样画布接近横向的长方形，宽屏上不用缩得太小。
 */
export function splitSides(tasks: BoardTask[]): Map<string, Side> {
  const total = tasks.reduce((n, t) => n + rowsOf(t), 0);
  const sides = new Map<string, Side>();
  let acc = 0;
  for (const t of tasks) {
    const side: Side = acc < total / 2 || tasks.length === 1 ? 'right' : 'left';
    sides.set(t.id, side);
    acc += rowsOf(t);
  }
  return sides;
}

/** 看板上需求的先后：没做完的在前、按优先级；同优先级先提的在前。 */
export function sortTasks(tasks: BoardTask[]): BoardTask[] {
  return [...tasks].sort(
    (a, b) =>
      Number(isTaskClosed(a)) - Number(isTaskClosed(b)) ||
      a.priority - b.priority ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export function buildGraph(board: Board, filter: BoardFilter): Graph {
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
    if (parent) {
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
    }
  };

  const tasks = sortTasks(filterTasks(board.tasks, filter));
  const sides = splitSides(tasks);
  const rootId = nodeId.repo(board.repo.id);
  add(rootId, { kind: 'repo', repo: board.repo, counts: repoCounts(board.tasks) });

  for (const t of tasks) {
    const side = sides.get(t.id) ?? 'right';
    const tid = nodeId.task(t.id);
    const tTone = taskTone(t);
    add(tid, { kind: 'task', task: t, side }, { id: rootId, side, tone: tTone, live: taskLive(t) });
    // 已完成、已叫停的需求收起来，只留一个节点，免得画布越堆越满。
    if (isTaskClosed(t)) continue;
    const subs = [...t.subtasks].sort((a, b) => a.index - b.index);
    for (const s of subs) {
      const sid = nodeId.sub(s.id);
      const sTone = subtaskTone(s);
      const letter = letterOf(s.index);
      add(
        sid,
        { kind: 'sub', sub: s, task: t, letter, side },
        { id: tid, side, tone: sTone, live: subLive(s) },
      );
      if (s.prNumber) {
        const prLive = s.state === 'verifying' || s.state === 'in_merge_queue';
        add(
          nodeId.pr(s.id),
          { kind: 'pr', prNumber: s.prNumber, sub: s, task: t, letter, side },
          { id: sid, side, tone: sTone, live: prLive },
        );
      }
    }
  }

  const structureKey = nodes.map((n) => `${n.id}@${n.side ?? 'root'}`).join('|');
  return { nodes, edges, parentOf, childrenOf, structureKey };
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
