// 时限从一张预算表派生（讨论稿第五节 1；旧坑 A2、A4）：每层只拿上层的绝对截止时刻，自己的时限只能更早，
// 不各算各的相对时限（旧系统驱动和插头各算一份，先到的回 aborted 盖掉真原因）。

export interface Budget {
  /** 起进程后多久还没有实质事件就判「起来后无进展」（A1）。reclaude 首跑卡在「Syncing config…」上百秒，给足。 */
  startupMs: number;
  /** 这一层的总时限，含收尾和回写。 */
  totalMs: number;
  /** 没有工具在跑、又这么久没有实质事件就判停滞；不给就不判。 */
  idleMs?: number;
  /** 先发 SIGTERM，过这么久还没退就 SIGKILL。 */
  killGraceMs: number;
}

export const BUDGETS = {
  /** 指挥官一轮：读、派、查，不动手。 */
  commanderTurn: { startupMs: 180_000, totalMs: 15 * 60_000, idleMs: 5 * 60_000, killGraceMs: 5_000 },
  /** 工人一轮：改代码、跑测试，一轮测试能跑十几分钟（工具在跑时不算停滞）。 */
  workerTurn: { startupMs: 180_000, totalMs: 60 * 60_000, idleMs: 10 * 60_000, killGraceMs: 5_000 },
} as const satisfies Record<string, Budget>;

export class BudgetTooLongError extends Error {
  constructor(ownMs: number, leftMs: number) {
    super(`这一层的预算 ${fmtMs(ownMs)} 比上层剩下的 ${fmtMs(leftMs)} 长：改预算表，不默默截短`);
    this.name = 'BudgetTooLongError';
  }
}

/** 这一层的绝对截止时刻。没有上层就是 now + 总时限；有上层时自己的总时限比上层剩下的长，启动就报错（A4）。 */
export function deriveDeadline(now: Date, own: Budget, parentDeadline?: Date): Date {
  const mine = new Date(now.getTime() + own.totalMs);
  if (!parentDeadline) return mine;
  const left = parentDeadline.getTime() - now.getTime();
  if (own.totalMs > left) throw new BudgetTooLongError(own.totalMs, Math.max(0, left));
  return mine;
}

export function fmtMs(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`;
}
