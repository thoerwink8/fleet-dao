// 哪些账号池整池暂停着（选路 real/store-ports.ts、切号 real/org-switch.ts + real/org-plan.ts 读同一份，口径一个）。两个来源：
// 1. 开关（#746）：设置 engine.poolHolds，人拍的临时停用，带原因、撤回条件、复查日期。探针探通、会话跑通都不碰它，只有人在驾驶舱撤；
//    认不出（整份或某个池那一项）按暂停办，调用方要把 facts.problems 报出来（org-switch 的一轮报 session-org:pool-hold），不当成能用；
// 2. 旧的 `pool-hold:<池>` 提醒（兼容读法，保留一版）：引擎发现登录失效、封号这类整池问题写的，探针探通、会话跑通会撤。人拍的暂停
//    原先也靠它顶着，所以驾驶舱在读到它时提示「请迁成开关」（shared 的 poolHoldsView）。引擎自己写提醒的两处（real/route-probe.ts、
//    real/session-pool-hold.ts）没动：它们只管提醒，碰不到开关。
// 改这里之前必须知道：switched 里的池连「续会话的试探」也不放过去（提醒顶着的池放，那一单就是看修好了没有；开关暂停的是人的决定，
// 没有「修好了」这回事）。库读不了照抛，不当成没有暂停。
import { type Db, listPoolIds, openAlertsByPrefix, readPoolHoldsSetting } from '@fleet-dao/db';
import { type PoolHoldFacts, resolvePoolHolds } from '@fleet-dao/shared';

/** 账号池整池暂停（设备被撤销、封号、登录失效、欠费：要人修）的提醒：dedupe_key = pool-hold:<池>。 */
export const POOL_HOLD_PREFIX = 'pool-hold:';
export const poolHoldKey = (poolId: string) => `${POOL_HOLD_PREFIX}${poolId}`;

export interface HeldPools {
  /** 整池避开的池：开关加提醒。 */
  all: Set<string>;
  /** 开关来的（含那一项认不出的；整份认不出时是库里所有池）：续会话的试探也不放过去。 */
  switched: Set<string>;
  /** 只靠 pool-hold: 提醒顶着、没有开关的池。 */
  alertOnly: string[];
  /** 开关的现状：认得出的、认不出的、到期没复查的。 */
  facts: PoolHoldFacts;
}

export async function loadHeldPools(db: Db, now: Date): Promise<HeldPools> {
  const [setting, alerts] = await Promise.all([
    readPoolHoldsSetting(db),
    openAlertsByPrefix(db, POOL_HOLD_PREFIX),
  ]);
  const facts = resolvePoolHolds(setting.set ? setting.value : undefined, now);
  const switched = new Set(facts.heldPoolIds);
  if (facts.holdAll) for (const id of await listPoolIds(db)) switched.add(id);
  const fromAlerts = alerts.map((a) => a.dedupeKey.slice(POOL_HOLD_PREFIX.length)).filter(Boolean);
  const all = new Set([...switched, ...fromAlerts]);
  return { all, switched, alertOnly: fromAlerts.filter((p) => !switched.has(p)), facts };
}
