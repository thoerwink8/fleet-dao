// 首页看板的图（model.ts）：节点层级、左右分边、过滤、聚焦一支、迷你时间线。纯函数，直接喂 /api/home 形状的数据。
import { describe, expect, test } from 'vitest';
import type { HomeFlowStage, HomeRunning } from '../types';
import {
  buildGraph,
  countTones,
  groupSegments,
  isStuck,
  lineage,
  nodeId,
  phasesOf,
  ROOT_ID,
  splitSides,
  worstTone,
} from './model';

const FLOW: HomeFlowStage[] = [
  { segment: 'scope', inFlight: 1, avgMs: 8 * 60_000, samples: 5 },
  { segment: 'manual', inFlight: 2, avgMs: 41 * 60_000, samples: 4 },
  { segment: 'verify', inFlight: 1, samples: 0 },
];

function ticket(n: number, over: Partial<HomeRunning> = {}): HomeRunning {
  return {
    issueNumber: n,
    title: `第 ${n} 张单`,
    repo: 'acme/orbit',
    segment: 'doing',
    waitingReason: 'nothing',
    link: `/tasks/t-${n}`,
    taskId: `t-${n}`,
    ...over,
  };
}

const RUNNING: HomeRunning[] = [
  ticket(1, { segment: 'scoping', waitingReason: 'founder_decision', pendingDecision: '要不要先开演练场？' }),
  ticket(2, { segment: 'doing', worker: 'Opus 5.5', stageSince: '2026-10-07T01:00:00Z' }),
  ticket(3, {
    segment: 'doing',
    lastEvent: { text: '动手超时：30 分钟没交活', at: '2026-10-07T01:00:00Z', tone: 'trouble' },
  }),
  ticket(4, { segment: 'verify_pending', waitingReason: 'verify_round' }),
];

describe('图的层级：引擎 → 三段 → 单子 →（要你拍）', () => {
  test('中心一个、三段各一个、每张单一个；等你拍的单再挂一片「要你拍」', () => {
    const g = buildGraph({ running: RUNNING, flow: FLOW, filter: { stuck: false } });
    expect(g.nodes[0]?.id).toBe(ROOT_ID);
    expect(g.nodes.filter((n) => n.data.kind === 'segment').map((n) => n.id)).toEqual([
      'segment:scope',
      'segment:manual',
      'segment:verify',
    ]);
    expect(g.nodes.filter((n) => n.data.kind === 'ticket').map((n) => n.id)).toEqual(
      expect.arrayContaining(RUNNING.map((r) => `ticket:${r.issueNumber}:acme/orbit`)),
    );
    expect(g.parentOf.get(nodeId.ticket(RUNNING[1] as HomeRunning))).toBe('segment:manual');
    expect(g.parentOf.get(nodeId.ticket(RUNNING[3] as HomeRunning))).toBe('segment:verify');
    expect(g.parentOf.get(nodeId.ask(RUNNING[0] as HomeRunning))).toBe(
      nodeId.ticket(RUNNING[0] as HomeRunning),
    );
    expect(g.nodes.filter((n) => n.data.kind === 'ask')).toHaveLength(1);
    expect(g.shown).toBe(4);
    expect(g.total).toBe(4);
  });

  test('推不出在哪一段的单挂在「还没分段」下面；没有这样的单就不出这一支', () => {
    const withNone = buildGraph({
      running: [...RUNNING, ticket(9, { segment: null })],
      flow: FLOW,
      filter: { stuck: false },
    });
    expect(withNone.parentOf.get('ticket:9:acme/orbit')).toBe('segment:none');
    const without = buildGraph({ running: RUNNING, flow: FLOW, filter: { stuck: false } });
    expect(without.nodes.some((n) => n.id === 'segment:none')).toBe(false);
  });

  test('一张单都没有：三段照样在（它们是流程本身），每段 0 张', () => {
    const g = buildGraph({ running: [], flow: FLOW, filter: { stuck: false } });
    const segs = g.nodes.filter((n) => n.data.kind === 'segment');
    expect(segs).toHaveLength(3);
    for (const s of segs) expect(s.data.kind === 'segment' && s.data.total).toBe(0);
  });

  test('段里的单：等你拍的 → 出问题的 → 本段待得久的在前', () => {
    const groups = groupSegments(
      [
        ticket(10, { stageSince: '2026-10-07T03:00:00Z' }),
        ticket(11, { stageSince: '2026-10-07T01:00:00Z' }),
        ticket(12, { lastEvent: { text: '失败', at: '2026-10-07T01:00:00Z', tone: 'trouble' } }),
        ticket(13, { pendingDecision: '拍一下' }),
      ],
      FLOW,
      { stuck: false },
    );
    expect(groups.find((g) => g.key === 'manual')?.items.map((i) => i.issueNumber)).toEqual([13, 12, 11, 10]);
  });
});

describe('左右分边：两边高度尽量相等，前面的段在右边', () => {
  test('4 / 4 / 3 张：对题在右，动手、验收在左（差 3 比差 5 小）', () => {
    const running = [
      ...[1, 2, 3, 4].map((n) => ticket(n, { segment: 'scoping' })),
      ...[5, 6, 7, 8].map((n) => ticket(n, { segment: 'doing' })),
      ...[9, 10, 11].map((n) => ticket(n, { segment: 'verifying' })),
    ];
    const sides = splitSides(groupSegments(running, FLOW, { stuck: false }));
    expect(sides.get('scope')).toBe('right');
    expect(sides.get('manual')).toBe('left');
    expect(sides.get('verify')).toBe('left');
  });

  test('全挤在动手：对题、动手在右，验收在左；左边不空着', () => {
    const running = [1, 2, 3, 4, 5, 6].map((n) => ticket(n, { segment: 'doing' }));
    const sides = splitSides(groupSegments(running, FLOW, { stuck: false }));
    expect([...sides.values()]).toContain('left');
    expect(sides.get('scope')).toBe('right');
  });

  test('边跟着段走：单子、要你拍和它所在的段同一边', () => {
    const g = buildGraph({ running: RUNNING, flow: FLOW, filter: { stuck: false } });
    for (const n of g.nodes) {
      const parent = g.parentOf.get(n.id);
      if (!parent || parent === ROOT_ID) continue;
      expect(n.side, n.id).toBe(g.nodes.find((x) => x.id === parent)?.side);
    }
  });
});

describe('过滤「只看卡住的」', () => {
  test('卡住的 = 等你拍、出问题了；还没验、排队不算（是正常的等）', () => {
    expect(isStuck(RUNNING[0] as HomeRunning)).toBe(true);
    expect(isStuck(RUNNING[2] as HomeRunning)).toBe(true);
    expect(isStuck(RUNNING[3] as HomeRunning)).toBe(false);
    expect(isStuck(ticket(5, { waitingReason: 'queue' }))).toBe(false);
  });

  test('过滤只藏单子，不藏段；段上的「在途」数照旧按全部算', () => {
    const g = buildGraph({ running: RUNNING, flow: FLOW, filter: { stuck: true } });
    expect(g.nodes.filter((n) => n.data.kind === 'ticket').map((n) => n.id)).toEqual([
      'ticket:1:acme/orbit',
      'ticket:3:acme/orbit',
    ]);
    expect(g.nodes.filter((n) => n.data.kind === 'segment')).toHaveLength(3);
    const verify = g.nodes.find((n) => n.id === 'segment:verify')?.data;
    expect(verify?.kind === 'segment' && verify.total).toBe(1);
    expect(g.shown).toBe(2);
    expect(g.total).toBe(4);
  });
});

describe('颜色', () => {
  test('还没验不画成失败红：verify_pending 的单是 stall，段的颜色也不是 fail', () => {
    const counts = countTones([RUNNING[3] as HomeRunning]);
    expect(counts.stall).toBe(1);
    expect(counts.fail).toBe(0);
    expect(worstTone(counts)).toBe('stall');
  });

  test('一段里最要紧的颜色：等你 > 出问题 > 在跑', () => {
    expect(worstTone(countTones(RUNNING))).toBe('human');
    expect(worstTone(countTones(RUNNING.slice(1)))).toBe('fail');
    expect(worstTone(countTones([RUNNING[1] as HomeRunning]))).toBe('run');
  });

  test('连线流动只给真有模型在跑的单', () => {
    const g = buildGraph({ running: RUNNING, flow: FLOW, filter: { stuck: false } });
    const live = g.edges.filter((e) => e.live).map((e) => e.target);
    expect(live).toContain('ticket:2:acme/orbit');
    expect(live).not.toContain('ticket:3:acme/orbit');
    expect(live).toContain('segment:manual');
    expect(live).not.toContain('segment:scope');
  });
});

describe('聚焦一支', () => {
  test('选中一段：它自己、中心、段下的单和叶子亮着，别的段和单变暗', () => {
    const g = buildGraph({ running: RUNNING, flow: FLOW, filter: { stuck: false } });
    const keep = lineage(g, 'segment:scope');
    expect(keep).toEqual(new Set([ROOT_ID, 'segment:scope', 'ticket:1:acme/orbit', 'ask:1:acme/orbit']));
  });
});

describe('迷你时间线：对题 → 动手 → 验收 → 合并', () => {
  test('动手中：对题走过、动手在这一段、验收合并还没到', () => {
    expect(phasesOf(ticket(1, { segment: 'doing' })).map((p) => p.state)).toEqual([
      'done',
      'active',
      'pending',
      'pending',
    ]);
  });

  test('还没验：验收那格写「还没验」、颜色是 stall 不是 fail', () => {
    const p = phasesOf(ticket(1, { segment: 'verify_pending', waitingReason: 'verify_round' }));
    expect(p[2]).toMatchObject({ label: '还没验', state: 'active', tone: 'stall' });
  });

  test('推不出在哪一段：四格都画成没到，不猜', () => {
    expect(phasesOf(ticket(1, { segment: null })).every((p) => p.state === 'pending')).toBe(true);
  });
});
