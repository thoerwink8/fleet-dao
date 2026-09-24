import { beforeAll, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { Board } from '../api/types';
import { layoutGraph } from './layout';
import { buildGraph, type Graph, nodeId } from './model';

const NOW = Date.parse('2026-09-25T10:00:00Z');
const boards = new Map<string, Board>();

beforeAll(async () => {
  const api = createMockApi({ live: false, now: () => NOW });
  for (const id of ['r-fleet', 'r-canary']) boards.set(id, await api.board(id));
});

function boardOf(repoId: string): Board {
  const b = boards.get(repoId);
  if (!b) throw new Error(`没有仓 ${repoId}`);
  return b;
}

const ALL = { stuck: false, mine: null };

function boxes(graph: Graph, pos: Map<string, { x: number; y: number }>) {
  return graph.nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) throw new Error(`${n.id} 没排上位置`);
    return { id: n.id, side: n.side, x: p.x, y: p.y, w: n.width, h: n.height };
  });
}

describe('看板的图', () => {
  test('仓 → 需求 → 子任务 → PR：开了 PR 的子任务外面挂一张 PR 卡', () => {
    const graph = buildGraph(boardOf('r-fleet'), ALL);
    expect(graph.parentOf.get(nodeId.pr('t-14-a'))).toBe(nodeId.sub('t-14-a'));
    expect(graph.parentOf.get(nodeId.sub('t-14-a'))).toBe(nodeId.task('t-14'));
    expect(graph.parentOf.get(nodeId.task('t-14'))).toBe(nodeId.repo('r-fleet'));
  });

  test('做完的需求收成一张卡，不展开子任务', () => {
    const graph = buildGraph(boardOf('r-fleet'), ALL);
    expect(graph.nodes.some((n) => n.id === nodeId.task('t-11'))).toBe(true);
    expect(graph.childrenOf.get(nodeId.task('t-11'))).toBeUndefined();
  });

  test('只看我提的：按用户编号过滤', () => {
    const graph = buildGraph(boardOf('r-fleet'), { stuck: false, mine: ['u-lan', '阿岚'] });
    const tasks = graph.nodes.flatMap((n) => (n.data.kind === 'task' ? [n.data.task.issueNumber] : []));
    expect(tasks).toEqual([12, 15, 18, 19, 21]);
  });

  test('状态变了（颜色、文字）排版指纹不变；节点增减才变', async () => {
    const api = createMockApi({ live: false, now: () => NOW });
    const before = buildGraph(await api.board('r-fleet'), ALL).structureKey;
    await api.taskAction('t-12', { action: 'pause' });
    expect(buildGraph(await api.board('r-fleet'), ALL).structureKey).toBe(before);
    await api.taskAction('t-12', { action: 'stop' });
    expect(buildGraph(await api.board('r-fleet'), ALL).structureKey).not.toBe(before);
  });
});

describe('思维导图排版', () => {
  test('仓在中间：右半边的都在仓右边，左半边的都在仓左边', async () => {
    const graph = buildGraph(boardOf('r-fleet'), ALL);
    const all = boxes(graph, await layoutGraph(graph));
    const root = all.find((b) => b.id === nodeId.repo('r-fleet'));
    if (!root) throw new Error('没有仓节点');
    const right = all.filter((b) => b.side === 'right');
    const left = all.filter((b) => b.side === 'left');
    expect(right.length).toBeGreaterThan(0);
    expect(left.length).toBeGreaterThan(0);
    for (const b of right) expect(b.x).toBeGreaterThanOrEqual(root.x + root.w);
    for (const b of left) expect(b.x + b.w).toBeLessThanOrEqual(root.x);
  });

  test('卡片互不重叠', async () => {
    const graph = buildGraph(boardOf('r-fleet'), ALL);
    const all = boxes(graph, await layoutGraph(graph));
    const overlaps: string[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        if (!a || !b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        if (!apart) overlaps.push(`${a.id} × ${b.id}`);
      }
    }
    expect(overlaps).toEqual([]);
  });

  test('子任务在它的需求外侧，PR 在它的子任务外侧', async () => {
    const graph = buildGraph(boardOf('r-fleet'), ALL);
    const pos = await layoutGraph(graph);
    for (const [child, parent] of graph.parentOf) {
      const node = graph.nodes.find((n) => n.id === child);
      const c = pos.get(child);
      const p = pos.get(parent);
      if (!node?.side || !c || !p || parent.startsWith('repo:')) continue;
      if (node.side === 'right') expect(c.x).toBeGreaterThan(p.x);
      else expect(c.x).toBeLessThan(p.x);
    }
  });

  test('两个需求左右各一，只有一个需求时只排右半边', async () => {
    const two = buildGraph(boardOf('r-canary'), ALL);
    expect(two.nodes.filter((n) => n.data.kind === 'task').map((n) => n.side)).toEqual(['right', 'left']);

    const board = boardOf('r-canary');
    const one = buildGraph({ ...board, tasks: board.tasks.slice(0, 1) }, ALL);
    expect(one.nodes.filter((n) => n.side === 'left').map((n) => n.id)).toEqual([]);
    const pos = await layoutGraph(one);
    expect(pos.size).toBe(one.nodes.length);
  });
});
