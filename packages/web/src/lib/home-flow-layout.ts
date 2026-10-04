// 主页三段流水线图的版式：每个泳道一个节点、每张在途的单一个卡片节点，位置全由这里算死（不让拖散）。
// 纯函数，不碰 react-flow：测试直接喂数据看坐标，组件只管把结果交给画布。
// 改这里之前必须知道：
// - 泳道先后固定对题 → 动手 → 验收（SEGMENT_ORDER）；推不出在哪一段的单（segment=null）落进最右边的「还没分段」泳道，
//   只有真有这样的单才出现，不拿空泳道占地方。
// - 每个泳道最多摆 MAX_CARDS 张卡，多的合成一个「还有 N 张」的节点，点了去任务列表；不是丢掉。
// - 单子排序：先等着创始人拍的（红点）、再出了问题的（trouble）、再按本段待得久的在前——最该看的在最上面。

import { laneOf, type SegmentKind } from '@fleet-dao/shared';
import type { HomeFlowStage, HomeRunning } from '../components/home/types';
import { SEGMENT_ORDER } from './segments';

export const HEADER_H = 92;
export const CARD_H = 124;
export const MORE_H = 36;
export const GAP = 10;
export const PAD = 10;
export const LANE_GAP = 36;
export const MAX_CARDS = 5;
export const MIN_ROWS = 2;
export const MIN_LANE_W = 250;

export type LaneKey = SegmentKind | 'none';

export interface LaneInfo {
  key: LaneKey;
  stage: HomeFlowStage | undefined;
  items: HomeRunning[];
  /** 摆不下、合成「还有 N 张」的那几张。 */
  hidden: HomeRunning[];
}

export type FlowNodeData =
  | { kind: 'lane'; lane: LaneInfo }
  | { kind: 'ticket'; item: HomeRunning }
  | { kind: 'more'; count: number; lane: LaneKey };

export interface FlowNode {
  id: string;
  type: 'lane' | 'ticket' | 'more';
  position: { x: number; y: number };
  width: number;
  height: number;
  zIndex: number;
  data: FlowNodeData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** 源泳道里有在途的单：边上的虚线流动起来。 */
  animated: boolean;
}

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

/** 这张单排在泳道里的先后：等你拍的 → 出问题的 → 本段待得久的。 */
export function ticketRank(item: HomeRunning): [number, number, number] {
  const blocked = item.pendingDecision !== undefined || item.waitingReason === 'founder_decision' ? 0 : 1;
  const trouble = item.lastEvent?.tone === 'trouble' ? 0 : 1;
  const since = item.stageSince ? Date.parse(item.stageSince) : Number.POSITIVE_INFINITY;
  return [blocked, trouble, Number.isFinite(since) ? since : Number.POSITIVE_INFINITY];
}

export function compareTickets(a: HomeRunning, b: HomeRunning): number {
  const ra = ticketRank(a);
  const rb = ticketRank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.issueNumber - b.issueNumber;
}

export function groupLanes(running: readonly HomeRunning[], flow: readonly HomeFlowStage[]): LaneInfo[] {
  const keys: LaneKey[] = [...SEGMENT_ORDER];
  if (running.some((r) => laneOf(r.segment) === null)) keys.push('none');
  return keys.map((key) => {
    const all = running.filter((r) => (laneOf(r.segment) ?? 'none') === key).sort(compareTickets);
    return {
      key,
      stage: key === 'none' ? undefined : flow.find((f) => f.segment === key),
      items: all.slice(0, MAX_CARDS),
      hidden: all.slice(MAX_CARDS),
    };
  });
}

/** 容器宽度 → 一条泳道多宽（装不下 MIN_LANE_W 时保底，画布自己出横向平移）。 */
export function laneWidth(containerWidth: number, lanes: number): number {
  const inner = containerWidth - PAD * 2 - LANE_GAP * (lanes - 1);
  return Math.max(MIN_LANE_W, Math.floor(inner / lanes));
}

export function buildFlowLayout(
  running: readonly HomeRunning[],
  flow: readonly HomeFlowStage[],
  containerWidth: number,
): FlowLayout {
  const lanes = groupLanes(running, flow);
  const w = laneWidth(containerWidth, lanes.length);
  const bodyH =
    Math.max(
      MIN_ROWS * (CARD_H + GAP),
      ...lanes.map((l) => l.items.length * (CARD_H + GAP) + (l.hidden.length > 0 ? MORE_H + GAP : 0)),
    ) + GAP;
  const laneH = HEADER_H + bodyH;
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  lanes.forEach((lane, i) => {
    const x = PAD + i * (w + LANE_GAP);
    nodes.push({
      id: `lane:${lane.key}`,
      type: 'lane',
      position: { x, y: PAD },
      width: w,
      height: laneH,
      zIndex: 0,
      data: { kind: 'lane', lane },
    });
    lane.items.forEach((item, j) => {
      nodes.push({
        id: `ticket:${item.issueNumber}:${item.repo}`,
        type: 'ticket',
        position: { x: x + PAD, y: PAD + HEADER_H + GAP + j * (CARD_H + GAP) },
        width: w - PAD * 2,
        height: CARD_H,
        zIndex: 1,
        data: { kind: 'ticket', item },
      });
    });
    if (lane.hidden.length > 0) {
      nodes.push({
        id: `more:${lane.key}`,
        type: 'more',
        position: { x: x + PAD, y: PAD + HEADER_H + GAP + lane.items.length * (CARD_H + GAP) },
        width: w - PAD * 2,
        height: MORE_H,
        zIndex: 1,
        data: { kind: 'more', count: lane.hidden.length, lane: lane.key },
      });
    }
    const next = lanes[i + 1];
    // 三段之间有箭头；「还没分段」不在流程里，不连线
    if (next && next.key !== 'none') {
      edges.push({
        id: `edge:${lane.key}:${next.key}`,
        source: `lane:${lane.key}`,
        target: `lane:${next.key}`,
        animated: lane.items.length + lane.hidden.length > 0,
      });
    }
  });
  const lastX = PAD + (lanes.length - 1) * (w + LANE_GAP) + w;
  return { nodes, edges, width: lastX + PAD, height: laneH + PAD * 2 };
}
