// 三段流水线图的版式（纯函数）：单子落在哪条泳道、泳道里谁在前、摆不下的怎么合、泳道多宽。
import { describe, expect, test } from 'vitest';
import type { HomeFlowStage, HomeRunning } from '../components/home/types';
import {
  buildFlowLayout,
  CARD_H,
  compareTickets,
  GAP,
  groupLanes,
  HEADER_H,
  LANE_GAP,
  laneWidth,
  MAX_CARDS,
  MIN_LANE_W,
  PAD,
} from './home-flow-layout';

const FLOW: HomeFlowStage[] = [
  { segment: 'scope', inFlight: 0, samples: 0 },
  { segment: 'manual', inFlight: 0, samples: 0 },
  { segment: 'verify', inFlight: 0, samples: 0 },
];

function t(n: number, over: Partial<HomeRunning> = {}): HomeRunning {
  return {
    issueNumber: n,
    title: `单 ${n}`,
    repo: 'a/b',
    segment: 'doing',
    waitingReason: 'nothing',
    link: `/tasks/${n}`,
    ...over,
  };
}

describe('groupLanes', () => {
  test('按段落泳道：scoping → 对题；doing → 动手；verifying / verify_pending / merge → 验收', () => {
    const lanes = groupLanes(
      [
        t(1, { segment: 'scoping' }),
        t(2, { segment: 'doing' }),
        t(3, { segment: 'verifying' }),
        t(4, { segment: 'verify_pending' }),
        t(5, { segment: 'merge' }),
      ],
      FLOW,
    );
    expect(lanes.map((l) => [l.key, l.items.map((i) => i.issueNumber)])).toEqual([
      ['scope', [1]],
      ['manual', [2]],
      ['verify', [3, 4, 5]],
    ]);
  });

  test('segment=null 的单落进第四条「还没分段」；没有这样的单就没有第四条', () => {
    expect(groupLanes([t(1)], FLOW).map((l) => l.key)).toEqual(['scope', 'manual', 'verify']);
    const lanes = groupLanes([t(1), t(2, { segment: null })], FLOW);
    expect(lanes.map((l) => l.key)).toEqual(['scope', 'manual', 'verify', 'none']);
    expect(lanes[3]?.items.map((i) => i.issueNumber)).toEqual([2]);
    expect(lanes[3]?.stage).toBeUndefined();
  });

  test(`超过 ${MAX_CARDS} 张的合到 hidden，一张都不丢`, () => {
    const lanes = groupLanes(
      Array.from({ length: 9 }, (_, i) => t(i + 1)),
      FLOW,
    );
    const manual = lanes.find((l) => l.key === 'manual');
    expect(manual?.items).toHaveLength(MAX_CARDS);
    expect(manual?.hidden).toHaveLength(4);
  });

  test('排序：等你拍的在最前，其次出问题的，再按本段待得久的在前', () => {
    const founder = t(10, { pendingDecision: '拍不拍', stageSince: '2026-10-05T01:00:00Z' });
    const trouble = t(11, {
      lastEvent: { text: '动手超时', at: '2026-10-05T01:00:00Z', tone: 'trouble' },
      stageSince: '2026-10-05T01:30:00Z',
    });
    const old = t(12, { stageSince: '2026-10-05T00:00:00Z' });
    const fresh = t(13, { stageSince: '2026-10-05T02:00:00Z' });
    const noSince = t(14);
    const sorted = [fresh, noSince, old, trouble, founder].sort(compareTickets).map((x) => x.issueNumber);
    expect(sorted).toEqual([10, 11, 12, 13, 14]);
  });
});

describe('buildFlowLayout', () => {
  test('泳道宽度随容器走，装不下时保底，不挤成缝', () => {
    expect(laneWidth(1200, 3)).toBe(Math.floor((1200 - PAD * 2 - LANE_GAP * 2) / 3));
    expect(laneWidth(300, 3)).toBe(MIN_LANE_W);
  });

  test('卡片落在自己泳道的正下方、一张一行，不重叠；每个节点都带死的宽高', () => {
    const layout = buildFlowLayout([t(1, { segment: 'scoping' }), t(2), t(3)], FLOW, 1200);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const lane = byId.get('lane:manual');
    const a = [...byId.values()].filter((n) => n.type === 'ticket');
    expect(a).toHaveLength(3);
    const manualCards = a.filter(
      (n) =>
        n.position.x > (lane?.position.x ?? 0) && n.position.x < (lane?.position.x ?? 0) + (lane?.width ?? 0),
    );
    expect(manualCards.map((n) => n.id)).toEqual(['ticket:2:a/b', 'ticket:3:a/b']);
    expect(manualCards[1]?.position.y).toBe((manualCards[0]?.position.y ?? 0) + CARD_H + GAP);
    expect(manualCards[0]?.position.y).toBe(PAD + HEADER_H + GAP);
    for (const n of layout.nodes) {
      expect(n.width).toBeGreaterThan(0);
      expect(n.height).toBeGreaterThan(0);
    }
    // 画布够高：最低的卡也在泳道里面
    const bottom = Math.max(...a.map((n) => n.position.y + n.height));
    expect(layout.height).toBeGreaterThan(bottom);
  });

  test('「还有 N 张」节点在最后一张卡下面，数对', () => {
    const layout = buildFlowLayout(
      Array.from({ length: 8 }, (_, i) => t(i + 1)),
      FLOW,
      1200,
    );
    const more = layout.nodes.find((n) => n.type === 'more');
    expect(more?.data).toMatchObject({ kind: 'more', count: 3, lane: 'manual' });
    const last = layout.nodes.filter((n) => n.type === 'ticket').at(-1);
    expect(more?.position.y).toBe((last?.position.y ?? 0) + CARD_H + GAP);
  });

  test('边只连三段、不连「还没分段」；源泳道有在途的才流动', () => {
    const layout = buildFlowLayout([t(1, { segment: 'scoping' }), t(2, { segment: null })], FLOW, 1200);
    expect(layout.edges.map((e) => [e.source, e.target, e.animated])).toEqual([
      ['lane:scope', 'lane:manual', true],
      ['lane:manual', 'lane:verify', false],
    ]);
  });

  test('一张单都没有：三条空泳道照样排得出（保底两行高），没有边在流动', () => {
    const layout = buildFlowLayout([], FLOW, 1200);
    expect(layout.nodes.map((n) => n.type)).toEqual(['lane', 'lane', 'lane']);
    expect(layout.edges.every((e) => !e.animated)).toBe(true);
    expect(layout.height).toBeGreaterThanOrEqual(PAD * 2 + HEADER_H + 2 * (CARD_H + GAP));
  });
});
