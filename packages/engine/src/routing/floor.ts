// 能力下限（#2725）：按用途和派工档定最低强弱档，选路排序之前当硬过滤。纯函数、确定性。
// 「不能为了用额度把难单派给弱模型」：下限只看用途、派工档和模型的强弱档（deploy/catalog.json 的 strength），
// 额度高低、池子超不超前都不放宽它。只有够格的全被硬挡（不算等空位、不算 2 小时内会好）时才降一档，永远不降到轻档。
// 判据只在下面一张表里，别处不另写。

import type { ModelStrength, StageKind } from '@fleet-dao/shared';
import { groupOf } from './group.ts';
import { routeLabel } from './names.ts';
import type { Block, RouteFacts, RouteTier } from './types.ts';

/**
 * 用途 × 派工档 → 最低强弱档。表里没有的用途、没给档的单不设下限（对题、Jev、整理待办这些不分档）。
 * - 动手、界面：主力档要强档，中档要标准档以上，快档轻档也行。
 * - 验收：主力档和中档都要强档（验收判对错，难单不能交给弱模型判）；快档轻档也行。
 */
export const STRENGTH_FLOOR: Readonly<
  Partial<Record<StageKind, Readonly<Record<RouteTier, ModelStrength>>>>
> = {
  execute: { heavyweight: 'strong', medium: 'standard', fast: 'light' },
  ui: { heavyweight: 'strong', medium: 'standard', fast: 'light' },
  verify: { heavyweight: 'strong', medium: 'strong', fast: 'light' },
};

/** 够格的路由在等、等的东西这么久之内会好，就不算硬挡（不降档，等它）。 */
export const FLOOR_SOON_MS = 2 * 3_600_000;

const RANK: Readonly<Record<ModelStrength, number>> = { light: 0, standard: 1, strong: 2 };
const LABEL: Readonly<Record<ModelStrength, string>> = { strong: '强档', standard: '标准档', light: '轻档' };
const TIER_LABEL: Readonly<Record<RouteTier, string>> = {
  heavyweight: '主力档',
  medium: '中档',
  fast: '快档',
};
const STAGE_LABEL: Partial<Record<StageKind, string>> = { execute: '动手', ui: '界面', verify: '验收' };

/** 这一用途、这一档的下限；不设下限（或下限就是轻档）为空。 */
export function floorOf(stage: StageKind, tier: RouteTier | undefined): ModelStrength | null {
  if (!tier) return null;
  const floor = STRENGTH_FLOOR[stage]?.[tier] ?? null;
  return floor === 'light' ? null : floor;
}

/** 一条候选：路由和它的挡因。 */
export interface FloorRow {
  route: RouteFacts;
  blocks: readonly Block[];
  /** 判降不降档时看的挡因：调用方把「这一问只派别家」这种换族挡因去掉（问到那一族时它照样能派），不给就用 blocks。 */
  judgeBlocks?: readonly Block[];
}

export interface FloorDecision {
  /** 表里的下限。 */
  floor: ModelStrength;
  /** 这一次实际用的下限：够格的全被硬挡时降一档（不降到轻档）。 */
  effective: ModelStrength;
  /** 降了档：为什么（写进派工理由）。没降为空。 */
  lowered: string | null;
  /** 够不上下限的路由 → 硬挡（写明为什么没派它）。 */
  below: Map<string, Block>;
}

/**
 * 没标强弱档的模型：认不出强弱，照决定 0099「没标档照以前」不按下限挡（标档在 deploy/catalog.json）。
 * 标了的才比。
 */
function meets(route: RouteFacts, floor: ModelStrength): boolean {
  const s = route.strength ?? null;
  return s === null || RANK[s] >= RANK[floor];
}

/** 一条路由此刻派不出、2 小时内也好不了：硬挡，或在等（不是等空位）且等的时刻不知道（额度）或在 2 小时以后。 */
function stuck(blocks: readonly Block[], now: number): boolean {
  const g = groupOf(blocks);
  if (g.kind === 'ready') return false;
  if (g.kind === 'hard') return true;
  if (g.waitFor === 'slot') return false;
  if (g.until === null) return g.waitFor === 'quota';
  return g.until - now > FLOOR_SOON_MS;
}

/**
 * 下限硬过滤：rows 是这一用途的候选（含已经被别的原因挡着的）。
 * 够格（强弱档不低于下限，或没标档）的里面有一条不是「硬挡、2 小时内好不了」，就照下限挡；
 * 够格的全都派不出（或一条够格的都没有）时降一档，降到轻档就不降（轻档永远不接有下限的单）。
 */
export function applyFloor(
  rows: readonly FloorRow[],
  stage: StageKind,
  tier: RouteTier,
  floor: ModelStrength,
  now: number,
): FloorDecision {
  const work = `${TIER_LABEL[tier]}的${STAGE_LABEL[stage] ?? '这一用途'}`;
  const alive = (f: ModelStrength) =>
    rows.some((r) => meets(r.route, f) && !stuck(r.judgeBlocks ?? r.blocks, now));
  let effective = floor;
  let lowered: string | null = null;
  if (!alive(floor) && floor === 'strong') {
    const down: ModelStrength = 'standard';
    const strong = rows.filter((r) => r.route.strength === 'strong');
    const why =
      strong.length === 0
        ? `这一用途没有${LABEL[floor]}的路由`
        : `${LABEL[floor]}的 ${strong.length} 条路由都被挡着、2 小时内好不了（${strong
            .slice(0, 3)
            .map((r) => `${routeLabel(r.route)}：${r.blocks.map((b) => b.text).join('、') || '派不出'}`)
            .join('；')}${strong.length > 3 ? `；另有 ${strong.length - 3} 条` : ''}）`;
    effective = down;
    lowered = `${work}下限是${LABEL[floor]}，${why}，这一次降一档到${LABEL[down]}；轻档仍不派`;
  }
  const below = new Map<string, Block>();
  for (const r of rows) {
    if (meets(r.route, effective)) continue;
    const s = r.route.strength as ModelStrength;
    const tail =
      effective === floor
        ? `${work}要${LABEL[floor]}${floor === 'strong' ? '' : '以上'}，${r.route.modelName} 是${LABEL[s]}（额度剩多少都不放宽）`
        : `${work}下限${LABEL[floor]}、够格的都派不出才降到${LABEL[effective]}，${r.route.modelName} 是${LABEL[s]}，仍够不上（不降到轻档）`;
    below.set(r.route.routeId, {
      code: 'below-floor',
      text: `够不上能力下限：${tail}`,
      wait: null,
      until: null,
    });
  }
  return { floor, effective, lowered, below };
}
