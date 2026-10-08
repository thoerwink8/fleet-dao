// 整池暂停到了复查日期：每小时对账往飞书推一条（#954）。同一天、同一份正文只推一次。
// 没配 webhook、推不出去、记不下「推过」：进这一轮的没查成，不当成推过（推不出去时不记已推）。
// 认不出的条目不写进正文，同时记没查成：不当成「没有到期的」。
import { beijingDateOf, overduePoolHoldPushText, resolvePoolHolds } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { SweepPart } from './reconcile-common.ts';

export const POOL_HOLD_PUSH_TITLE = '整池暂停到了复查日期，已推飞书';
export const POOL_HOLD_PUSH_LINK = '/settings';

/** 一天一条。正文对得上才算推过；过了北京时间的今天，键换一天，该再推再推。 */
export const poolHoldPushKey = (day: string): string => `feishu:pool-hold-overdue:${day}`;

export interface PoolHoldPushDeps {
  now: () => Date;
  /** 没设过 = { set: false }。库读不了照抛。 */
  readSetting: () => Promise<{ set: false } | { set: true; value: unknown }>;
  /** 这个键上一次记下的正文；没有回 null。读不了照抛。 */
  sentBody: (dedupeKey: string) => Promise<string | null>;
  markSent: (input: { dedupeKey: string; title: string; body: string; link: string }) => Promise<void>;
  /** 没配、推不出去照抛。抛出的话里不带 webhook 地址。 */
  send: (text: string) => Promise<void>;
}

export async function pushOverduePoolHolds(deps: PoolHoldPushDeps): Promise<SweepPart> {
  let setting: { set: false } | { set: true; value: unknown };
  try {
    setting = await deps.readSetting();
  } catch (err) {
    return {
      failed: `整池暂停的设置没读成：${errMessage(err)}`,
      scanned: 0,
      found: 0,
      unchecked: [],
    };
  }
  if (!setting.set) return { scanned: 0, found: 0, unchecked: [] };

  const now = deps.now();
  const facts = resolvePoolHolds(setting.value, now);
  const today = beijingDateOf(now);
  const scanned = facts.holdAll ? 1 : facts.heldPoolIds.length;
  const unread =
    facts.problems.length > 0
      ? `整池暂停有认不出的条目（${facts.problems.map((p) => p.poolId ?? '整份').join('、')}），到期推送只含认得出的`
      : null;
  const text = overduePoolHoldPushText(facts.holds, today);
  if (!text) {
    return { scanned, found: 0, unchecked: unread ? [unread] : [] };
  }

  const key = poolHoldPushKey(today);
  let previous: string | null;
  try {
    previous = await deps.sentBody(key);
  } catch (err) {
    return {
      scanned,
      found: 0,
      unchecked: [`整池暂停到期：查今天推过没有没查成：${errMessage(err)}`, ...(unread ? [unread] : [])],
    };
  }
  if (previous === text) return { scanned, found: 0, unchecked: unread ? [unread] : [] };

  try {
    await deps.send(text);
  } catch (err) {
    return {
      scanned,
      found: 0,
      unchecked: [`整池暂停到期，飞书没推成：${errMessage(err)}`, ...(unread ? [unread] : [])],
    };
  }
  try {
    await deps.markSent({
      dedupeKey: key,
      title: POOL_HOLD_PUSH_TITLE,
      body: text,
      link: POOL_HOLD_PUSH_LINK,
    });
  } catch (err) {
    return {
      scanned,
      found: 1,
      unchecked: [
        `整池暂停到期的飞书已经推出去了，但没记下（下一小时可能再推一次）：${errMessage(err)}`,
        ...(unread ? [unread] : []),
      ],
    };
  }
  return { scanned, found: 1, unchecked: unread ? [unread] : [] };
}
