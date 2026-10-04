// 整池暂停的判法（#746）：引擎选路、切号（engine 的 real/pool-holds.ts）、驾驶舱后端（api 的 pool-holds-view.ts）、设置页读同一份。
//
// 开关只存在库里的设置键 engine.poolHolds（形状见 web-api.ts 的 PoolHoldsSettingSchema）：{池编号: {reason, decidedBy, revokeWhen,
// reviewBy}}，写入走设置的 PUT（带版本号、进操作记录）。它和 `pool-hold:<池>` 提醒是两回事：提醒是引擎发现登录失效、封号这类
// 「人修好了就自己撤」时写的，探针探通、会话跑通会撤；开关是人拍的临时停用，引擎任何一步都不撤它。
//
// 改这里之前必须知道：
// - 读不到、认不出一律按暂停办，不当成能用：整份认不出（不是对象、被人直接改库）→ holdAll（所有池都停）；只是某个池那一项认不出
//   （缺字段、日期不是日历上的一天、多了不认识的字段）→ 只停这个池，并带原因报出来。只有「库里根本没有这一项」才是没有暂停；
// - 到了 reviewBy（北京时间当天及以后）只标 overdue，不自动撤：撤不撤是人的事（撤，或写明理由续期）。
import type { z } from 'zod';
import { PoolHoldSchema, type PoolHoldsResponse } from './web-api.ts';

/** 设置表里整池暂停那一项的键（和 web-api 的 SETTING_SCHEMAS 里同名）。 */
export const POOL_HOLDS_SETTING = 'engine.poolHolds';

export interface PoolHold {
  reason: string;
  decidedBy: string;
  revokeWhen: string;
  /** YYYY-MM-DD，北京时间。 */
  reviewBy: string;
}

export interface PoolHoldFact extends PoolHold {
  poolId: string;
  overdue: boolean;
  overdueDays: number;
}

export interface PoolHoldProblem {
  poolId: string | null;
  why: string;
}

export interface PoolHoldFacts {
  /** 认得出的暂停。 */
  holds: PoolHoldFact[];
  /** 认不出的：某个池那一项（poolId 有值，这个池照样按暂停办），或整份（poolId 为 null，同时 holdAll）。 */
  problems: PoolHoldProblem[];
  /** 整份认不出：所有池都按暂停办（调用方自己列出所有池）。 */
  holdAll: boolean;
  /** 要整池避开的池：认得出的加上那一项认不出的（整份认不出时为空，看 holdAll）。 */
  heldPoolIds: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_MS = 8 * 60 * 60 * 1000;

/** 北京日期（YYYY-MM-DD）。 */
export function beijingDateOf(at: Date): string {
  return new Date(at.getTime() + BEIJING_MS).toISOString().slice(0, 10);
}

/** reviewBy 到了没有：今天（北京时间）≥ 复查日期。日期必须是 YYYY-MM-DD（调用方已过 schema），过了几天按日历天数算。 */
export function reviewStatus(reviewBy: string, now: Date): { overdue: boolean; overdueDays: number } {
  const today = beijingDateOf(now);
  if (today < reviewBy) return { overdue: false, overdueDays: 0 };
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${reviewBy}T00:00:00Z`)) / DAY_MS);
  return { overdue: true, overdueDays: Math.max(0, days) };
}

const issueText = (issue: { path: PropertyKey[]; message: string } | undefined): string =>
  issue ? `${issue.path.map(String).join('.') || '整项'}：${issue.message}` : '格式不对';

/**
 * 设置里读到的原值（undefined = 库里没有这一行 = 没有暂停）变成现状。整份不是 {池编号: 条目} 的对象，所有池按暂停办；
 * 某个池的条目认不出，这个池按暂停办、写明原因。
 */
export function resolvePoolHolds(setting: unknown, now: Date): PoolHoldFacts {
  if (setting === undefined) return { holds: [], problems: [], holdAll: false, heldPoolIds: [] };
  if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) {
    return {
      holds: [],
      problems: [
        {
          poolId: null,
          why: `设置 ${POOL_HOLDS_SETTING} 的值不是 {池编号: {reason, decidedBy, revokeWhen, reviewBy}}：${JSON.stringify(setting)}，所有账号池按暂停办`,
        },
      ],
      holdAll: true,
      heldPoolIds: [],
    };
  }
  const holds: PoolHoldFact[] = [];
  const problems: PoolHoldProblem[] = [];
  const heldPoolIds: string[] = [];
  for (const [poolId, entry] of Object.entries(setting as Record<string, unknown>)) {
    heldPoolIds.push(poolId);
    const parsed = PoolHoldSchema.safeParse(entry);
    if (!parsed.success) {
      problems.push({
        poolId,
        why: `设置 ${POOL_HOLDS_SETTING} 里 ${poolId} 的暂停认不出（${issueText(parsed.error.issues[0])}），这个池照样按暂停办`,
      });
      continue;
    }
    holds.push({ poolId, ...parsed.data, ...reviewStatus(parsed.data.reviewBy, now) });
  }
  return { holds, problems, holdAll: false, heldPoolIds };
}

// —— 驾驶舱视图（api 的 /pool-holds 和 web 的假数据服务共用这一份）——

export type PoolHoldsView = z.infer<typeof PoolHoldsResponse>;

const POOL_HOLD_ALERT_PREFIX = 'pool-hold:';

/** 视图要的提醒的几项（api 的 NotificationRecord、假数据的通知都满足）。 */
export interface LegacyAlertLike {
  dedupeKey?: string | undefined;
  title: string;
  createdAt: string;
  resolvedAt?: string | undefined;
}

/** 旧提醒读成了几条（读成了才有 alerts；没读成给原因，不拿「没有」顶）。 */
export type LegacyRead = { ok: true; alerts: readonly LegacyAlertLike[] } | { ok: false; why: string };

/**
 * 设置原值（undefined = 没设过）加旧 pool-hold:<池> 提醒 → 驾驶舱看的现状：到期标红（overdue）、认不出的明说、
 * 还靠提醒顶着的列出来（驾驶舱提示「请迁成开关」）。
 */
export function poolHoldsView(
  setting: { value: unknown; version: number } | undefined,
  legacy: LegacyRead,
  now: Date,
): PoolHoldsView {
  const facts = resolvePoolHolds(setting?.value, now);
  const switched = new Set(facts.heldPoolIds);
  const alerts = legacy.ok
    ? legacy.alerts
        .filter((a) => a.dedupeKey?.startsWith(POOL_HOLD_ALERT_PREFIX) && !a.resolvedAt)
        .map((a) => {
          const poolId = (a.dedupeKey ?? '').slice(POOL_HOLD_ALERT_PREFIX.length);
          return { poolId, title: a.title, since: a.createdAt, alsoSwitched: switched.has(poolId) };
        })
        .filter((a) => a.poolId)
    : [];
  return {
    holds: facts.holds,
    problems: facts.problems,
    holdAll: facts.holdAll,
    legacy: alerts,
    ...(legacy.ok ? {} : { legacyProblem: legacy.why }),
    version: setting?.version ?? 0,
    today: beijingDateOf(now),
    asOf: now.toISOString(),
  };
}

/**
 * 改整池暂停设置前的检查：已有的条目被撤掉、或改了内容（含改复查日期续期）时，这次改动必须写原因（进操作记录）；新建的不用。
 * 改之前的值认不出（整份、某一项）时没法比，也要原因：多半是在修坏掉的设置。返回 null = 可以落库，否则是拒绝的话。
 * before 是改之前设置的原值（没设过 undefined 或 null）。
 */
export function revocationProblem(
  before: unknown,
  after: unknown,
  reason: string | undefined,
): string | null {
  const given = typeof reason === 'string' && reason.trim() !== '';
  if (given || before === undefined || before === null) return null;
  const isMap = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isMap(before)) return `改 ${POOL_HOLDS_SETTING} 要写原因（现在存着的值认不出，这次是在修它）`;
  const next = isMap(after) ? after : {};
  const touched = Object.entries(before)
    .filter(([poolId, entry]) => {
      const changed = next[poolId];
      if (changed === undefined) return true;
      const a = PoolHoldSchema.safeParse(entry);
      const b = PoolHoldSchema.safeParse(changed);
      return !(a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data));
    })
    .map(([poolId]) => poolId);
  return touched.length === 0
    ? null
    : `撤回或改 ${touched.join('、')} 的暂停要写原因（撤回写为什么能撤了，续期写为什么还要停）：这次改动没带 reason`;
}
