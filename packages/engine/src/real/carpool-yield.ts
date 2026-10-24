// 独享一个明确可用的都没有（被封、到期都算）→ 引擎让出拼车给本机（#3687 批次 6，需求方 2026-10-24 原话：「独享号封号期间我只剩拼车
// 可用，这时 VPS 驾驶舱先不要用拼车额度」）。是 org-plan.ts 的 soloPauseOf（设置项「引擎暂不用独享」）的镜像，但由独享状态自动触发。
//
// 状态只有一份：驾驶舱提醒 CARPOOL_YIELD_KEY。它开着 = 拼车池整池暂停着；real/pool-holds.ts 的 loadHeldPools 把它和开关、
// pool-hold: 提醒并成同一份「整池暂停」，选路、切号、拼车盯读都读那一份，这里不另起一套平行状态，也不碰选路和切号的判法。
// 这里只管写：切号每一轮（real/org-switch.ts 的 run）拿账号清单判一次，开、撤、让人放开的都在这个文件。
//
// 改这里之前必须知道：
// - 只认「清单读成了、独享那类至少列出一个账号、且一个明确 available 的都没有、也没有读不到状态的」。读不到（清单没读成、有账号 unknown、
//   清单里一个独享账号都没列）一律不动现状：开着的不撤、没开的不开，由切号照现有方式报「读不到账号状态」。
// - 人在驾驶舱把这条标已处理 = 手动放开：这一段独享不可用期间不再开。恢复（独享重新有 available）时重新武装，下次封号照常让出。
//   靠处理人区分：引擎自己撤的处理人是 by；别人处理的（人点的）就是放开。
// - 独享恢复自动撤。撤和重新武装都走 resolveAlertWithReason，留撤的原因。
import { alertByKey, type Db, resolveAlertWithReason, upsertAlert } from '@fleet-dao/db';
import { type AccountRoster, judgeAccounts } from '../jobs/org-accounts.ts';
import { readingStamp } from './session-org.ts';

/** 独享不可用、引擎让出拼车的提醒：dedupe_key。开着 = 拼车池整池暂停（real/pool-holds.ts 读它）。 */
export const CARPOOL_YIELD_KEY = 'carpool-yield:solo-down';
export const CARPOOL_YIELD_TITLE = '独享不可用，引擎让出拼车给本机';

export type SoloState = { state: 'down'; why: string } | { state: 'up' } | { state: 'unknown'; why: string };

/** 独享这一类现在是什么状态（纯判法，复用 judgeAccounts 的按类计数）。 */
export function soloStateOf(roster: AccountRoster): SoloState {
  if (!roster.readOk) return { state: 'unknown', why: `账号清单没读成：${roster.readWhy}` };
  const verdict = judgeAccounts(roster);
  const solo = verdict.byKind.solo;
  if (solo.available > 0) return { state: 'up' };
  if (solo.unknown > 0) return { state: 'unknown', why: `独享有 ${solo.unknown} 个账号读不到状态` };
  if (solo.total === 0) return { state: 'unknown', why: '账号清单里没有独享账号' };
  return { state: 'down', why: verdict.summary };
}

export type CarpoolYieldOutcome =
  /** 让出着（刚开、或本来就开着）。 */
  | 'yielding'
  /** 独享不可用，但人已经手动放开了这一段。 */
  | 'released'
  /** 独享可用，没有让出（这一轮撤掉的、重新武装的、本来就没有的都是）。 */
  | 'clear'
  /** 读不到独享状态，现状不动。 */
  | 'unchanged';

/**
 * 按账号清单开、撤让出拼车的提醒。库读写不了照抛，由切号一轮的外层记日志（和 publishPoolHolds 一样）。
 * by：引擎这一路的处理人，撤时记它；提醒的处理人不是它，就是人点的。
 */
export async function syncCarpoolYield(
  db: Db,
  input: { roster: AccountRoster; now: Date; by: string },
): Promise<CarpoolYieldOutcome> {
  const solo = soloStateOf(input.roster);
  if (solo.state === 'unknown') return 'unchanged';
  const row = await alertByKey(db, CARPOOL_YIELD_KEY);
  const open = row !== null && row.resolvedAt === null;
  const byHuman = row !== null && row.resolvedAt !== null && row.resolvedBy !== input.by;
  if (solo.state === 'down') {
    if (open) return 'yielding';
    if (byHuman) return 'released';
    await upsertAlert(db, {
      dedupeKey: CARPOOL_YIELD_KEY,
      level: 'alert',
      taskId: null,
      title: CARPOOL_YIELD_TITLE,
      body: [
        `开始时刻（北京时间）：${readingStamp(input.now)}。${solo.why}。`,
        '独享没有明确可用的账号，本机只剩拼车能用：引擎先不往拼车派 Claude 步骤、也不往拼车切（别家照跑）；已停下的 Claude 步骤照旧挂着等，不算失败。',
        '独享重新有可用账号时，这条自动撤、拼车自动恢复。要现在就放开：把这条标已处理（这一段独享不可用期间不再让出）。',
      ].join('\n'),
    });
    return 'yielding';
  }
  if (open) {
    await resolveAlertWithReason(db, {
      dedupeKey: CARPOOL_YIELD_KEY,
      by: input.by,
      why: '独享重新有明确可用的账号了，拼车自动恢复',
      at: input.now,
    });
  } else if (byHuman) {
    // 人放开过：独享恢复了，把这条交回引擎名下（重开再撤一次），下次封号才会再让出
    await upsertAlert(db, {
      dedupeKey: CARPOOL_YIELD_KEY,
      level: 'alert',
      taskId: null,
      title: CARPOOL_YIELD_TITLE,
      body: '独享恢复，重新武装。',
    });
    await resolveAlertWithReason(db, {
      dedupeKey: CARPOOL_YIELD_KEY,
      by: input.by,
      why: '独享重新有明确可用的账号了，下次独享不可用时重新让出拼车',
      at: input.now,
    });
  }
  return 'clear';
}
