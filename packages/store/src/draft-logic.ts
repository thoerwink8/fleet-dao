/**
 * 飞书草稿（确认、开单）两套 Store 共用的纯判断。
 * 改这里之前必须知道：pg 版对草稿行加行锁后再判，内存版直接判；先后顺序（没有 → 已确认 → 版本对不上 → 才确认）必须一样，
 * 决定了「既已确认、版本又旧」时回 already。改草稿（reviseDraft）的幂等判断在 feishu-records.ts。
 */
import type { DraftRecord } from './ports.ts';

/** 草稿已经确认了：不能再改。 */
export const isDraftConfirmed = (status: DraftRecord['status']): boolean => status === 'confirmed';

/** 确认前先判：已经确认了回 already（重复确认不是错）；确认的版本不是现在这版回 changed（卡片过期了）；都对才能确认。 */
export function judgeConfirm(
  row: { status: DraftRecord['status']; revision: number },
  revision: number,
): 'already' | 'changed' | 'proceed' {
  if (isDraftConfirmed(row.status)) return 'already';
  if (row.revision !== revision) return 'changed';
  return 'proceed';
}

/** 等着开单：已经确认、还没有开成的任务。 */
export const isAwaitingOpen = (row: { status: DraftRecord['status']; hasTask: boolean }): boolean =>
  isDraftConfirmed(row.status) && !row.hasTask;
