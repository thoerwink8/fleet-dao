// 复用每天的对账轮次，只在周一写进度；不新起定时器、报警或必过检查。
import type { GuardInventory } from './guard-inventory.ts';
import { renderGuardInventory } from './guard-inventory.ts';

export interface InventoryProgress {
  /** 只读当天开始以来的评论；读不到必须抛，不能返回空。 */
  readSince(since: string): Promise<string[]>;
  note(text: string): Promise<void>;
}

export async function weeklyGuardProgress(
  report: GuardInventory,
  now: Date,
  progress: InventoryProgress,
): Promise<'skipped' | 'exists' | 'posted'> {
  if (!Number.isFinite(now.getTime())) throw new Error('每周库存进度没查成：时间无效');
  if (now.getUTCDay() !== 1) return 'skipped';
  const day = now.toISOString().slice(0, 10);
  const marker = `<!-- guard-inventory:${day} -->`;
  const comments = await progress.readSince(`${day}T00:00:00Z`);
  if (comments.some((comment) => comment.includes(marker))) return 'exists';
  await progress.note(`${renderGuardInventory(report)}\n\n${marker}`);
  return 'posted';
}
