// 日报级（daily）通知的收口。发版开始、发版成功这类发出去就没有人再点「处理」，驾驶舱「没处理的提醒」会被它们淹掉。
// 两条路，都走 resolveAlertWithReason（正文开头「已撤：…」、操作记录记一笔）：
// - 每日简报把它们写进去、飞书和 #1055 都发出去之后收（处理人 engine:daily-brief，「已收进 <日期> 简报」）。
// - 开着超过 48 小时还没被简报收的，每小时对账顺手收（处理人 engine:hourly-reconcile，「超过 48 小时自动收」）。
//   刚好满 48 小时还留着。时刻看 updated_at：还在被原地更新的（活摘要）不会被收掉又被下一次 upsert 重新打开。
// 简报自己那一行（feishu:brief:）不按「已收进」收：飞书推送要求它还开着。满 48 小时才走第二条。
// alert、decision 不进这里。
import { FEISHU_BRIEF_KEY_PREFIX } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { RECONCILE_ACTOR } from './reconcile-common.ts';

/** 每日简报收日报时记的处理人（notifications.resolved_by、操作记录的 actor_id）。 */
export const DAILY_BRIEF_ACTOR = 'engine:daily-brief';
/** 开着超过这么久还没被简报收的日报，每小时对账收掉。 */
export const DAILY_STALE_MS = 48 * 60 * 60_000;
/** 超过 48 小时那条的原因（resolveAlertWithReason 会在正文前加上「已撤：」）。 */
export const DAILY_STALE_WHY = '超过 48 小时自动收';
/** 收进某一天简报的原因。day 是北京日期 YYYY-MM-DD。 */
export const dailyIncludedWhy = (day: string): string => `已收进 ${day} 简报`;

export interface DailyNoteRef {
  dedupeKey: string;
  level: string;
  /** 48 小时那条用它。收进简报的那条用不到。 */
  updatedAt?: Date;
}

export interface SettleDailyResult {
  /** 这一轮标成已处理的键（原来就处理过的、没有的不算）。 */
  resolved: string[];
  /** 已经处理过，或库里没有。调用方把它从「还开着」里拿掉，但不算这一轮新收的。 */
  already: string[];
  /** 没收成的，一条一句。别的照收。 */
  failed: string[];
}

/**
 * 把该收的日报标已处理。includedDay 加上 includedKeys：这些键按「已收进简报」收（优先于 48 小时）。
 * 没给 includedDay：只收超过 48 小时的。非 daily 跳过。一条失败不挡别的。
 */
export async function settleDailyNotes(
  resolve: (input: {
    dedupeKey: string;
    by: string;
    why: string;
  }) => Promise<'ok' | 'already_resolved' | 'not_found'>,
  open: readonly DailyNoteRef[],
  opts: { now: Date; includedDay?: string | null; includedKeys?: ReadonlySet<string> | null },
): Promise<SettleDailyResult> {
  const resolved: string[] = [];
  const already: string[] = [];
  const failed: string[] = [];
  const included = opts.includedKeys ?? null;
  const day = opts.includedDay ?? null;
  for (const n of open) {
    if (n.level !== 'daily') continue;
    let by: string;
    let why: string;
    if (
      included !== null &&
      day !== null &&
      day !== '' &&
      included.has(n.dedupeKey) &&
      !n.dedupeKey.startsWith(FEISHU_BRIEF_KEY_PREFIX)
    ) {
      by = DAILY_BRIEF_ACTOR;
      why = dailyIncludedWhy(day);
    } else {
      const updated = n.updatedAt instanceof Date ? n.updatedAt.getTime() : Number.NaN;
      if (!Number.isFinite(updated) || opts.now.getTime() - updated <= DAILY_STALE_MS) continue;
      by = RECONCILE_ACTOR;
      why = DAILY_STALE_WHY;
    }
    try {
      const r = await resolve({ dedupeKey: n.dedupeKey, by, why });
      if (r === 'ok') resolved.push(n.dedupeKey);
      else already.push(n.dedupeKey);
    } catch (err) {
      failed.push(`提醒 ${n.dedupeKey} 没收成：${errMessage(err)}`);
    }
  }
  return { resolved, already, failed };
}
