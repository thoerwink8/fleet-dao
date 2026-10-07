// 首页看板的 ELK 排版（layout.ts）：引擎在中间、两侧展开、互不重叠；排不出来要报错，不能一直空着。
// 数据取假后端（mock）的 /api/home，和 mock 模式下页面上看到的一样。
import { beforeAll, describe, expect, test } from 'vitest';
import { createMockApi } from '../../../api/mock/server';
import type { HomeFlowStage, HomeRunning } from '../types';
import { type ElkHandle, layoutGraph } from './layout';
import { buildGraph, type Graph, ROOT_ID } from './model';

let running: HomeRunning[] = [];
let flow: HomeFlowStage[] = [];

beforeAll(async () => {
  const api = createMockApi({ live: false });
  const home = await api.home();
  running = home.running;
  flow = home.flow;
});

const graphOf = (rs: readonly HomeRunning[] = running) =>
  buildGraph({ running: rs, flow, filter: { stuck: false } });

function boxes(graph: Graph, pos: Map<string, { x: number; y: number }>) {
  return graph.nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) throw new Error(`${n.id} 没排上位置`);
    return { id: n.id, side: n.side, x: p.x, y: p.y, w: n.width, h: n.height };
  });
}

describe('思维导图排版', () => {
  test('假数据里有单，两边都有段（前提）', () => {
    expect(running.length).toBeGreaterThan(3);
    const g = graphOf();
    expect(g.nodes.some((n) => n.side === 'left')).toBe(true);
    expect(g.nodes.some((n) => n.side === 'right')).toBe(true);
  });

  test('引擎在中间：右半边的都在它右边，左半边的都在它左边', async () => {
    const graph = graphOf();
    const all = boxes(graph, await layoutGraph(graph));
    const root = all.find((b) => b.id === ROOT_ID);
    if (!root) throw new Error('没有中心节点');
    for (const b of all.filter((x) => x.side === 'right'))
      expect(b.x).toBeGreaterThanOrEqual(root.x + root.w);
    for (const b of all.filter((x) => x.side === 'left')) expect(b.x + b.w).toBeLessThanOrEqual(root.x);
  });

  test('卡片互不重叠', async () => {
    const graph = graphOf();
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

  test('单子在它的段外侧，要你拍在它的单外侧', async () => {
    const graph = graphOf();
    const pos = await layoutGraph(graph);
    for (const [child, parent] of graph.parentOf) {
      const node = graph.nodes.find((n) => n.id === child);
      const c = pos.get(child);
      const p = pos.get(parent);
      if (!node?.side || !c || !p || parent === ROOT_ID) continue;
      if (node.side === 'right') expect(c.x, child).toBeGreaterThan(p.x);
      else expect(c.x, child).toBeLessThan(p.x);
    }
  });

  test('一张单都没有：三段照样排出来', async () => {
    const graph = graphOf([]);
    const pos = await layoutGraph(graph);
    expect(pos.size).toBe(graph.nodes.length);
  });
});

describe('排版排不出来要报错，不能一直空着', () => {
  /** 一套假 ELK：layout 永远不回话，或者 Worker 报错。 */
  function fakeElk(kind: 'hang' | 'crash'): () => Promise<ElkHandle> {
    return async () => {
      const failed =
        kind === 'crash'
          ? Promise.reject(new Error('排版引擎出错：脚本没加载成'))
          : new Promise<never>(() => {});
      failed.catch(() => {});
      return {
        elk: { layout: () => new Promise(() => {}) } as unknown as ElkHandle['elk'],
        failed,
        dispose() {},
      };
    };
  }

  // structureKey 带上标记，免得命中前面测试排好的缓存。
  const fresh = (tag: string): Graph => {
    const g = graphOf();
    return { ...g, structureKey: `${g.structureKey}#${tag}` };
  };

  test('卡住不回话：到点就拒绝，并写明超时', async () => {
    await expect(layoutGraph(fresh('hang'), { elk: fakeElk('hang'), timeoutMs: 30 })).rejects.toThrow(
      /排版超过 0 秒没出结果/,
    );
  });

  test('Worker 出错：把原因原样报上来', async () => {
    await expect(layoutGraph(fresh('crash'), { elk: fakeElk('crash'), timeoutMs: 5000 })).rejects.toThrow(
      '排版引擎出错：脚本没加载成',
    );
  });

  test('失败的那次不进缓存：重试用好的 ELK 照常排出来', async () => {
    const g = fresh('retry');
    await expect(layoutGraph(g, { elk: fakeElk('hang'), timeoutMs: 30 })).rejects.toThrow();
    const pos = await layoutGraph(g);
    expect(pos.size).toBe(g.nodes.length);
  });
});
