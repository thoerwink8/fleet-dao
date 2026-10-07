// 三段流程和路由页「用途」的对照（#1224）。引擎选路、路由页、用途接口都读这一份，不各写一份。
// 库里的 StageKind 枚举和已有行不在这里删：triage、spec、plan、research、review 仍是合法值，只是页面和接口不列。
import type { StageKind } from './domain.ts';

/** 对题不选路。路由页只写这一句，不给它排模型。 */
export const SCOPE_NO_ROUTE = '在对话里做，不选路';

export interface RoutingPurpose {
  purpose: StageKind;
  /** 路由页上的名字。 */
  label: string;
  /** true = 不是流程里的一段，页面上单列。 */
  aside: boolean;
}

/**
 * 路由页和 /api 用途列表的顺序和名字。
 * 动手按 execute，界面活按 ui；验收按 verify；Jev 按 judge，单列，标明不是流程里的一段。
 */
export const ROUTING_PURPOSES = [
  { purpose: 'execute', label: '动手', aside: false },
  { purpose: 'ui', label: '动手 · 界面', aside: false },
  { purpose: 'verify', label: '验收', aside: false },
  { purpose: 'judge', label: 'Jev 判断', aside: true },
] as const satisfies readonly RoutingPurpose[];

export type RoutingPurposeId = (typeof ROUTING_PURPOSES)[number]['purpose'];

export const ROUTING_PURPOSE_IDS: readonly RoutingPurposeId[] = ROUTING_PURPOSES.map((p) => p.purpose);

export function routingPurposeOf(purpose: string): (typeof ROUTING_PURPOSES)[number] | undefined {
  return ROUTING_PURPOSES.find((p) => p.purpose === purpose);
}

export function routingPurposeLabel(purpose: string): string | undefined {
  return routingPurposeOf(purpose)?.label;
}

/** 页面上叫「验收」的那一格。没有就抛：对不上不能拿别的用途顶。 */
export function acceptancePurpose(): RoutingPurposeId {
  const cell = ROUTING_PURPOSES.find((p) => p.label === '验收');
  if (!cell) throw new Error('路由用途里没有叫「验收」的一格');
  return cell.purpose;
}

/**
 * 三段里经选路的那几段各按哪个用途选。
 * 动手按 execute（界面活按 UI_PURPOSE）。验收按页面上叫「验收」的那一格。
 * 对题不选路，不在这里。
 */
export const SEGMENT_STAGE = {
  manual: 'execute',
  verify: acceptancePurpose(),
} as const satisfies Record<'manual' | 'verify', RoutingPurposeId>;

/** 动手里的界面活按这个用途（模型顺序、禁令）。 */
export const UI_PURPOSE = 'ui' as const satisfies RoutingPurposeId;
