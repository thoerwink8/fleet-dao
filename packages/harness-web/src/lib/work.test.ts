// 任务波次图的纯函数（#3784）：波的校验与回退、折叠、紧凑卡、活跃波、上下游闭包、用时、布局输入、中文映射。
import type { WorkEdge, WorkNode } from '@fleet-dao/harness-contract/work-graph';
import { describe, expect, it } from 'vitest';
import { workCategoryLabel, workStateLabel } from './labels';
import { buildElkGraph, fallbackLayout, layoutGraph, moreId } from './work-layout';
import {
  activeWavePos,
  elapsedMs,
  formatElapsed,
  listRank,
  relatedIds,
  resolveWaves,
  retried,
  toneOf,
  viewWaves,
  worstState,
} from './work-model';

const node = (id: string, state = 'pending', over: Partial<WorkNode> = {}): WorkNode => ({
  id,
  label: id,
  state,
  attempt: 0,
  startedAt: null,
  completedAt: null,
  model: null,
  category: null,
  headline: null,
  runIds: [],
  score: null,
  ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => node(`n${i}`));
const wave = (index: number, ids: string[]) => ({ index, nodeIds: ids });

describe('波的校验与回退', () => {
  it('服务端给的波通过校验就原样用', () => {
    const r = resolveWaves({
      nodes: [node('a'), node('b')],
      waves: [wave(0, ['a']), wave(1, ['b'])],
      edges: [{ from: 'a', to: 'b' }],
    });
    expect(r.repaired).toBeNull();
    expect(r.waves).toEqual([wave(0, ['a']), wave(1, ['b'])]);
  });

  it('节点不在任何波里：自己推（按依赖深度），并写明原因', () => {
    const r = resolveWaves({
      nodes: [node('a'), node('b'), node('c')],
      waves: [wave(0, ['a'])],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    });
    expect(r.repaired).toBe('missing-from-waves');
    expect(r.waves.map((w) => w.nodeIds)).toEqual([['a'], ['b'], ['c']]);
  });

  it('依赖指向同波或更后的波（后向边）：自己推', () => {
    const r = resolveWaves({
      nodes: [node('a'), node('b')],
      waves: [wave(0, ['a', 'b'])],
      edges: [{ from: 'a', to: 'b' }],
    });
    expect(r.repaired).toBe('backward-edge');
    expect(r.waves.map((w) => w.nodeIds)).toEqual([['a'], ['b']]);
  });

  it('有环：环上的节点放进最后一波', () => {
    const edges: WorkEdge[] = [
      { from: 'b', to: 'c' },
      { from: 'c', to: 'b' },
    ];
    const r = resolveWaves({ nodes: [node('a'), node('b'), node('c')], waves: [], edges });
    expect(r.repaired).toBe('cycle');
    expect(r.waves.at(-1)?.nodeIds.sort()).toEqual(['b', 'c']);
  });

  it('影子批次：没有依赖，全在第 0 波', () => {
    const r = resolveWaves({ nodes: many(3), waves: [wave(0, ['n0', 'n1', 'n2'])], edges: [] });
    expect(r.repaired).toBeNull();
    expect(r.waves).toHaveLength(1);
  });
});

describe('活跃波', () => {
  it('第一个还有没结束节点的波；全结束了是最后一波', () => {
    const nodes = [node('a', 'completed'), node('b', 'failed'), node('c', 'running'), node('d', 'pending')];
    const waves = [wave(0, ['a', 'b']), wave(1, ['c']), wave(2, ['d'])];
    expect(activeWavePos(waves, nodes)).toBe(1);
    expect(
      activeWavePos(waves, [
        node('a', 'completed'),
        node('b', 'cancelled'),
        node('c', 'skipped'),
        node('d', 'completed'),
      ]),
    ).toBe(2);
    expect(activeWavePos([], [])).toBe(0);
  });
});

describe('折叠与紧凑卡', () => {
  it('13 个以内全画；14 个起只画前 12 个，后面接「+N 更多」，展开后全画', () => {
    const ids = (n: number) => many(n).map((x) => x.id);
    const v13 = viewWaves([wave(0, ids(13))], new Set())[0];
    expect(v13).toMatchObject({ more: 0, foldable: false, compact: false });
    expect(v13?.shown).toHaveLength(13);
    const v14 = viewWaves([wave(0, ids(14))], new Set())[0];
    expect(v14).toMatchObject({ more: 2, foldable: true });
    expect(v14?.shown).toHaveLength(12);
    const open = viewWaves([wave(0, ids(14))], new Set([0]))[0];
    expect(open).toMatchObject({ more: 0, foldable: true });
    expect(open?.shown).toHaveLength(14);
  });

  it('16 个起用紧凑卡', () => {
    const ids = many(16).map((x) => x.id);
    expect(viewWaves([wave(0, ids.slice(0, 15))], new Set())[0]?.compact).toBe(false);
    expect(viewWaves([wave(0, ids)], new Set())[0]?.compact).toBe(true);
  });
});

describe('高亮、用时、配色、重试', () => {
  it('上下游传递闭包；没边时只有自己', () => {
    const edges: WorkEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'x', to: 'c' },
      { from: 'a', to: 'd' },
    ];
    expect([...relatedIds('b', edges)].sort()).toEqual(
      ['a', 'b', 'c', 'd']
        .filter((x) => x !== 'd')
        .concat([])
        .sort(),
    );
    expect([...relatedIds('a', edges)].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...relatedIds('q', [])]).toEqual(['q']);
  });

  it('边按上游里最糟的状态着色', () => {
    expect(worstState(['completed', 'failed', 'pending'])).toBe('failed');
    expect(worstState(['completed', 'completed'])).toBe('completed');
    expect(worstState(['pending', 'running'])).toBe('running');
  });

  it('用时：在跑算到现在、结束了算开始到结束、没开始没有', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(elapsedMs(node('a', 'running', { startedAt: '2026-10-31T11:58:30Z' }), now)).toBe(90_000);
    expect(
      elapsedMs(
        node('a', 'completed', { startedAt: '2026-10-31T11:00:00Z', completedAt: '2026-10-31T11:05:05Z' }),
        now,
      ),
    ).toBe(305_000);
    expect(elapsedMs(node('a', 'pending'), now)).toBeNull();
    expect(elapsedMs(node('a', 'completed', { startedAt: '2026-10-31T11:00:00Z' }), now)).toBeNull();
    expect(formatElapsed(7_000)).toBe('7 秒');
    expect(formatElapsed(305_000)).toBe('5 分 05 秒');
    expect(formatElapsed(3_720_000)).toBe('1 时 02 分');
  });

  it('配色档：在跑蓝、做完绿、失败红、阻塞暂停黄、其余和不认识的灰', () => {
    expect(
      ['running', 'completed', 'failed', 'blocked', 'paused', 'pending', 'skipped', 'cancelled', 'weird'].map(
        toneOf,
      ),
    ).toEqual(['running', 'success', 'danger', 'warning', 'warning', 'muted', 'muted', 'muted', 'muted']);
  });

  it('重试过：当前尝试超过 1 或跑过多次', () => {
    expect(retried({ attempt: 2, runIds: ['a'] })).toBe(true);
    expect(retried({ attempt: 1, runIds: ['a', 'b'] })).toBe(true);
    expect(retried({ attempt: 1, runIds: ['a'] })).toBe(false);
  });

  it('列表排序：失败卡住在前、做完在后', () => {
    const order = ['completed', 'running', 'failed', 'pending', 'blocked'].sort(
      (a, b) => listRank(a) - listRank(b),
    );
    expect(order).toEqual(['failed', 'blocked', 'running', 'pending', 'completed']);
  });
});

describe('中文映射', () => {
  it('每种状态有中文名，原值留在 raw；不认识的原样显示', () => {
    expect(workStateLabel('running')).toEqual({ text: '在跑', raw: 'running' });
    expect(workStateLabel('blocked')?.text).toBe('被卡住');
    expect(workStateLabel('paused')?.text).toBe('已暂停');
    expect(workStateLabel('pending')?.text).toBe('排队中');
    expect(workStateLabel('from-the-future')).toEqual({ text: 'from-the-future', raw: 'from-the-future' });
    expect(workCategoryLabel('shadow')?.text).toBe('影子');
  });
});

describe('布局输入', () => {
  it('波号当 elk 的分区号；折叠的波接「+N 更多」格排在最后；只带两端都画出来的边', () => {
    const ids = many(14).map((x) => x.id);
    const views = viewWaves([wave(0, ids), wave(1, ['z'])], new Set());
    const g = buildElkGraph(views, [
      { from: 'n0', to: 'z' },
      { from: 'n13', to: 'z' },
    ]);
    expect(g.layoutOptions['elk.partitioning.activate']).toBe('true');
    const w0 = g.children.filter((c) => c.layoutOptions['elk.partitioning.partition'] === '0');
    expect(w0).toHaveLength(13);
    expect(w0.at(-1)?.id).toBe(moreId(0));
    expect(g.children.find((c) => c.id === 'z')?.layoutOptions['elk.partitioning.partition']).toBe('1');
    expect(g.edges).toHaveLength(1);
  });

  it('elk 真的把每一波排成一列、波从左到右', async () => {
    const views = viewWaves([wave(0, ['a', 'b', 'c']), wave(1, ['d', 'e'])], new Set());
    const l = await layoutGraph(views, [{ from: 'a', to: 'd' }]);
    const xs = (w: number) => new Set(l.nodes.filter((n) => n.wave === w).map((n) => n.x));
    expect(xs(0).size).toBe(1);
    expect(xs(1).size).toBe(1);
    expect([...xs(0)][0]).toBeLessThan([...xs(1)][0] as number);
    const ys = l.nodes.filter((n) => n.wave === 0).map((n) => n.y);
    expect(new Set(ys).size).toBe(3);
    expect(l.waves.map((w) => w.index)).toEqual([0, 1]);
  });

  it('退路布局：一波一列', () => {
    const l = fallbackLayout(viewWaves([wave(0, ['a', 'b']), wave(1, ['c'])], new Set()));
    expect(l.nodes.find((n) => n.id === 'c')?.x).toBeGreaterThan(l.nodes.find((n) => n.id === 'a')?.x ?? 0);
    expect(l.nodes.find((n) => n.id === 'b')?.y).toBeGreaterThan(l.nodes.find((n) => n.id === 'a')?.y ?? 0);
  });
});
