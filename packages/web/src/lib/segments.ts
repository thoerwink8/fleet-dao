// 三段（对题 / 动手 / 验收）给人看的说法（#216）。数一律出自 shared：每一笔用后端读好的（readSegmentRun），合计用
// summarizeUsage 的 bySegment；这里只管名字、颜色和「一项数怎么说」，不另算一遍。
import {
  SEGMENT_LABELS,
  SEGMENT_OUTCOME_LABELS,
  type SegmentKind,
  type SegmentOutcome,
  type SegmentTier,
  type UnreadItem,
} from '@fleet-dao/shared';
import type { TaskDetail } from '../api/types';
import type { Tone } from './status';

export type SegmentRunView = TaskDetail['segmentRuns'][number];
export type SegmentTotals = TaskDetail['usage']['bySegment'][number];

/** 固定先后：对题 → 动手 → 验收。 */
export const SEGMENT_ORDER: readonly SegmentKind[] = ['scope', 'manual', 'verify'];

export const segmentLabel = SEGMENT_LABELS;

/** 一句话说这一段干什么。 */
export const segmentHint: Record<SegmentKind, string> = {
  scope: '读单子，写清要什么',
  manual: '按改动面分档写代码',
  verify: '换一家冷调用来验',
};

/** 认不出的段（段名不在三段里）怎么叫。 */
export const UNKNOWN_SEGMENT = '段名认不出';

export const tierLabel: Record<SegmentTier, string> = { fast: '快档', medium: '中档', heavyweight: '主力档' };

/** 只有动手段分档；对题、验收没有派工档是对的，不写「没记」。 */
export const noTierText: Record<SegmentKind, string> = { scope: '不分档', manual: '没记', verify: '冷调用' };

export const segmentOutcomeLabel = SEGMENT_OUTCOME_LABELS;

export const segmentOutcomeTone: Record<SegmentOutcome, Tone> = {
  done: 'done',
  timeout: 'fail',
  killed: 'stop',
  spawn_failed: 'fail',
  admission_blocked: 'wait',
  failed: 'fail',
  // 引擎自己停的（#59）：不是失败，切完在原分支上重跑这一段
  org_switch: 'wait',
};

/** 哪一样没读到，叫什么。 */
export const unreadItemLabel: Record<UnreadItem, string> = {
  segment: '段名',
  time: '耗时',
  outcome: '结局',
  tokens: 'token',
  cost: '花费',
  tier: '派工档',
};

/** 一笔在跑的到现在跑了多久（开始时刻读不到就算不出，不给 0）。 */
export function liveMs(run: SegmentRunView, now: number): number | undefined {
  if (!run.running || run.startedAt === undefined) return undefined;
  return Math.max(0, now - Date.parse(run.startedAt));
}

/** 这一段用过的派工档怎么说：动手段全没记写「没记」，记了一部分写明几次没记；对题、验收写不分档 / 冷调用。 */
export function tierText(
  segment: SegmentKind | null,
  totals: Pick<SegmentTotals, 'tiers' | 'missingTier' | 'runs' | 'running'>,
): { text: string; missing: boolean; note?: string } {
  const named = totals.tiers.map((t) => tierLabel[t]).join('、');
  if (totals.missingTier > 0) {
    if (!named) return { text: '没记', missing: true };
    return { text: named, missing: false, note: `另有 ${totals.missingTier} 次没记` };
  }
  if (named) return { text: named, missing: false };
  return { text: segment ? noTierText[segment] : '—', missing: false };
}
