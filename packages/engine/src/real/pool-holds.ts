// 哪些账号池整池暂停着（选路 real/store-ports.ts、切号 real/org-switch.ts + real/org-plan.ts 读同一份，口径一个）。两个来源：
// 1. 开关（#746）：设置 engine.poolHolds，人在额度页拍的临时停用，带原因、撤回条件、复查日期（可不填）。探针探通、会话跑通都不碰它，只有人在额度页打开；
//    认不出（整份或某个池那一项）按暂停办，调用方要把 facts.problems 报出来（org-switch 的一轮报 session-org:pool-hold），不当成能用；
// 2. 独享一个可用的都没有 → 引擎让出拼车（#3687 批次 6，real/carpool-yield.ts）：提醒 carpool-yield:solo-down 开着，库里所有拼车池算暂停，
//    和开关一样连续会话的试探也不放过去（人在驾驶舱把那条标已处理 = 手动放开）；
// 3. 旧的 `pool-hold:<池>` 提醒（兼容读法，保留一版）：引擎发现登录失效、封号这类整池问题写的，探针探通、会话跑通会撤。额度页把封号、登录失效显示成「封号」，不自动改开关。
//    引擎自己写提醒的两处（real/route-probe.ts、real/session-pool-hold.ts）没动：它们只管提醒，碰不到开关。
// 改这里之前必须知道：switched 里的池连「续会话的试探」也不放过去（提醒顶着的池放，那一单就是看修好了没有；开关暂停的是人的决定，
// 没有「修好了」这回事）。库读不了照抛，不当成没有暂停。
import {
  carpoolPoolCaps,
  type Db,
  listPoolIds,
  openAlertsByPrefix,
  readPoolHoldsSetting,
} from '@fleet-dao/db';
import { type DecisionOption, type PoolHoldFacts, resolvePoolHolds } from '@fleet-dao/shared';
import { CARPOOL_YIELD_KEY } from './carpool-yield.ts';

/** 账号池整池暂停（设备被撤销、封号、登录失效、欠费：要人修）的提醒：dedupe_key = pool-hold:<池>。 */
export const POOL_HOLD_PREFIX = 'pool-hold:';
export const poolHoldKey = (poolId: string) => `${POOL_HOLD_PREFIX}${poolId}`;

/**
 * 整池暂停的选项。提醒开着时选路整池避开；「先停着」另外写进整池暂停开关（探针探通撤得掉提醒，撤不掉开关）。
 * 「修好了，放开」拿掉开关并转已处理，池子当场回来。「这个池不要了」带 keepsOpen：交给指挥官，提醒照旧开着、池子照旧停着。
 * 探针（route-probe）和任务工作流报警（store-ports 见 pool-hold: 去重键）用同一份。
 */
export function poolHoldOptions(poolId: string): DecisionOption[] {
  return [
    {
      id: 'fixed',
      label: '修好了，放开',
      detail: `放开账号池 ${poolId}：整池暂停开关里拿掉它，这条转已处理，选路当场能用`,
      recommended: '没修好也不怕：探针、会话再撞上同样的问题会再报一条、再停这个池',
      action: { kind: 'resume-pool', poolId },
    },
    {
      id: 'hold',
      label: '先停着',
      detail: `把账号池 ${poolId} 记进整池暂停开关（探针探通也不会放开）；记下了这条才转已处理`,
      action: { kind: 'pause-pool', poolId },
    },
    {
      id: 'retire',
      label: '这个池不要了',
      detail: `这条留着，账号池 ${poolId} 照旧停着；记下交给指挥官去把它从路由里下掉`,
      keepsOpen: true,
      action: { kind: 'note-only' },
    },
  ];
}

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

/**
 * 拼车盯读要不要整池停（real/carpool-watch.ts 的 pause.heldReason、看门狗放过 carpool-watch、引擎起来时不把这一行登记回来，
 * 三处同一句）：库里每个拼车池都在暂停里（开关或 pool-hold: 提醒）才算，回原因；一个拼车池都没有、或还有没停的，回 null。
 * 库读不了照抛，调用方不当成暂停。
 */
export async function carpoolPoolsHeldReason(db: Db, now: Date): Promise<string | null> {
  const [caps, held] = await Promise.all([carpoolPoolCaps(db), loadHeldPools(db, now)]);
  if (caps.length === 0 || !caps.every((c) => held.all.has(c.poolId))) return null;
  return `拼车池 ${caps.map((c) => c.poolId).join('、')} 整池暂停着`;
}

/**
 * ignoreYield：不算独享不可用时让出的拼车。只有账号清单的判法（org-plan.ts 的 loadOrgSwitchFacts）这样读：让出是由独享状态判出来的，
 * 清单再把它当「拼车账号不可用」读回去就绕成圈了（独享恢复时，拼车这一类还被自己的让出压着，渠道状态跟着错）。
 */
export async function loadHeldPools(
  db: Db,
  now: Date,
  options: { ignoreYield?: boolean } = {},
): Promise<HeldPools> {
  const [setting, alerts, yielded] = await Promise.all([
    readPoolHoldsSetting(db),
    openAlertsByPrefix(db, POOL_HOLD_PREFIX),
    options.ignoreYield ? Promise.resolve([]) : openAlertsByPrefix(db, CARPOOL_YIELD_KEY),
  ]);
  const facts = resolvePoolHolds(setting.set ? setting.value : undefined, now);
  const switched = new Set(facts.heldPoolIds);
  if (facts.holdAll) for (const id of await listPoolIds(db)) switched.add(id);
  if (yielded.length > 0) for (const c of await carpoolPoolCaps(db)) switched.add(c.poolId);
  const fromAlerts = alerts.map((a) => a.dedupeKey.slice(POOL_HOLD_PREFIX.length)).filter(Boolean);
  const all = new Set([...switched, ...fromAlerts]);
  return { all, switched, alertOnly: fromAlerts.filter((p) => !switched.has(p)), facts };
}
