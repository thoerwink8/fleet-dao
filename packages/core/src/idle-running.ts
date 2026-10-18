// 看门狗和受控修复共用的原条件；不碰网络、库或 Node 模块。
import { SELF_CHECK_ACTIVITY_MS, SELF_CHECK_DOING } from './self-check-budget.ts';

export const IDLE_RUNNING_STALE_MS = 20 * 60 * 1000;
export interface IdleRunningCondition {
  state: string;
  executor: string;
  openRuns: number;
  updatedAt: Date | null;
  doing: string | null;
}
export function isIdleRunningStale(
  row: IdleRunningCondition,
  now: Date,
  staleMs = IDLE_RUNNING_STALE_MS,
): boolean {
  if (row.state !== 'running' || row.executor !== 'engine' || row.openRuns !== 0) return false;
  const quietMs = row.doing?.includes(SELF_CHECK_DOING) ? Math.max(staleMs, SELF_CHECK_ACTIVITY_MS) : staleMs;
  return row.updatedAt === null || now.getTime() - row.updatedAt.getTime() >= quietMs;
}
