import type { Notifications } from '../api/types';

/**
 * 「待处理」的唯一口径：要你拍 + 卡住报警（接口的 counts，真实总数，不是这一页的条数）。
 * 日报只是看一眼，不算待处理；铃铛、侧栏角标、下拉标题、通知中心的「待处理」都用它。
 */
export function pendingCount(counts: Notifications['counts']): number {
  return counts.decision + counts.alert;
}
