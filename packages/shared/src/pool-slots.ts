// 账号池「满没满」只在这里判（#800）：占着的名额 = 在跑的 + 已选定还没开跑的（#757 之后选路在选定那一刻就预占名额），
// 到了并发上限就是满。引擎选路（engine 的 routing/filter.ts）、候选路由的挡因（db 的 queries/candidates.ts）、驾驶舱路由页和
// 「换路由」选项（web）都调它，不各写一份——只数在跑的，页面会说有空位、引擎却因为预占着的名额让新单等空位。
// 改这里之前必须知道：数不是非负整数就抛（读坏了的数不当成 0 个、不当成没满）。

export interface PoolSlots {
  /** 池上已开工、没结束的会话数。 */
  inFlight: number;
  /** 池上已选定、还没开跑的名额数（没过期的预占，Fusion 排着的）。 */
  reserved: number;
  maxConcurrency: number;
}

function count(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`账号池的${what}不是非负整数（${String(n)}），判不了满没满`);
  return n;
}

/** 占着的名额：在跑的 + 已选定还没开跑的。 */
export function poolOccupied(p: Pick<PoolSlots, 'inFlight' | 'reserved'>): number {
  return count(p.inFlight, '在跑数') + count(p.reserved, '已选定数');
}

/** 满了：占着的名额到了并发上限。 */
export function poolFull(p: PoolSlots): boolean {
  return poolOccupied(p) >= count(p.maxConcurrency, '并发上限');
}

/**
 * 占着几个、各是什么，白话一句：没有已选定的只说在跑几个；有的写明两样各几个。
 * 「已经有 3 个（在跑 1 个、已选定还没开工 2 个）」。
 */
export function poolOccupiedText(p: Pick<PoolSlots, 'inFlight' | 'reserved'>): string {
  const total = poolOccupied(p);
  return p.reserved > 0
    ? `已经有 ${total} 个（在跑 ${p.inFlight} 个、已选定还没开工 ${p.reserved} 个）`
    : `已经在跑 ${p.inFlight} 个`;
}
