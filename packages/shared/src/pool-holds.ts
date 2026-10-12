// 整池暂停的判法（#746）：引擎选路、切号（engine 的 real/pool-holds.ts）、驾驶舱后端（api 的 pool-holds-view.ts）、额度页读同一份。
//
// 开关只存在库里的设置键 engine.poolHolds（形状见 web-api.ts 的 PoolHoldsSettingSchema）：{池编号: {reason, decidedBy, revokeWhen,
// reviewBy?, owner?}}，写入走设置的 PUT（带版本号、进操作记录）。负责人没写，视图按「指挥官」。它和 `pool-hold:<池>` 提醒是两回事：提醒是引擎发现登录失效、封号这类
// 「人修好了就自己撤」时写的，探针探通、会话跑通会撤；开关是人在额度页拍的临时停用，引擎不写这个开关、也不撤它。
//
// 改这里之前必须知道：
// - 读不到、认不出一律按暂停办，不当成能用：整份认不出（不是对象、被人直接改库）→ holdAll（所有池都停）；只是某个池那一项认不出
//   （缺原因、谁拍的、撤回条件，日期填了但不是日历上的一天，多了不认识的字段）→ 只停这个池，并带原因报出来。只有「库里根本没有这一项」才是没有暂停；
// - 复查日期可不填：没填不算到期、不推复查提醒。填了的，到了 reviewBy（北京时间当天及以后）只标 overdue，不自动撤。
import type { z } from 'zod';
import { PoolHoldSchema, type PoolHoldsResponse } from './web-api.ts';

/** 设置表里整池暂停那一项的键（和 web-api 的 SETTING_SCHEMAS 里同名）。 */
export const POOL_HOLDS_SETTING = 'engine.poolHolds';

/** 库里没写负责人时，视图、飞书、开会话钩子都用这个（#954）。旧称帅位，现称指挥官。 */
export const DEFAULT_POOL_HOLD_OWNER = '指挥官';

export interface PoolHold {
  reason: string;
  decidedBy: string;
  revokeWhen: string;
  /** YYYY-MM-DD，北京时间。没写 = 不设复查日期，不算到期。 */
  reviewBy?: string;
  /** 没写 = 库里没有这一项，视图补成 DEFAULT_POOL_HOLD_OWNER。 */
  owner?: string;
}

export interface PoolHoldFact extends PoolHold {
  poolId: string;
  /** 视图上永远有：库里没写的已补成默认。 */
  owner: string;
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
  /**
   * 认不出的那一项的原值（池编号 → 库里那一项）。改别的池时要原样写回，不能丢掉，不然这个池会被放开。
   * 整份认不出时为空（那不是按池分的条目，看 holdAll）。
   */
  opaque: Record<string, unknown>;
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
const emptyFacts = (): PoolHoldFacts => ({
  holds: [],
  problems: [],
  holdAll: false,
  heldPoolIds: [],
  opaque: {},
});

export function resolvePoolHolds(setting: unknown, now: Date): PoolHoldFacts {
  if (setting === undefined) return emptyFacts();
  if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) {
    return {
      ...emptyFacts(),
      problems: [
        {
          poolId: null,
          why: `设置 ${POOL_HOLDS_SETTING} 的值不是 {池编号: {reason, decidedBy, revokeWhen, reviewBy?, owner?}}：${JSON.stringify(setting)}，所有账号池按暂停办`,
        },
      ],
      holdAll: true,
    };
  }
  const holds: PoolHoldFact[] = [];
  const problems: PoolHoldProblem[] = [];
  const heldPoolIds: string[] = [];
  const opaque: Record<string, unknown> = {};
  for (const [poolId, entry] of Object.entries(setting as Record<string, unknown>)) {
    heldPoolIds.push(poolId);
    const parsed = PoolHoldSchema.safeParse(entry);
    if (!parsed.success) {
      problems.push({
        poolId,
        why: `设置 ${POOL_HOLDS_SETTING} 里 ${poolId} 的暂停认不出（${issueText(parsed.error.issues[0])}），这个池照样按暂停办`,
      });
      opaque[poolId] = entry;
      continue;
    }
    const review = parsed.data.reviewBy
      ? reviewStatus(parsed.data.reviewBy, now)
      : { overdue: false, overdueDays: 0 };
    holds.push({
      poolId,
      reason: parsed.data.reason,
      decidedBy: parsed.data.decidedBy,
      revokeWhen: parsed.data.revokeWhen,
      owner: parsed.data.owner ?? DEFAULT_POOL_HOLD_OWNER,
      ...review,
      ...(parsed.data.reviewBy ? { reviewBy: parsed.data.reviewBy } : {}),
    });
  }
  return { holds, problems, holdAll: false, heldPoolIds, opaque };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 整池暂停的写入。新写的、改过的每一项必须过 PoolHoldSchema。
 * 库里已经认不出的那一项，原样带回来（和库里逐字一样）才收，这样改别的池不会把它们丢掉。
 * 新造一条认不出的、或改了认不出的内容：拒。整份不是对象的（holdAll）不能靠这一项混进去。
 */
export function acceptPoolHoldsWrite(
  before: unknown,
  after: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!isPlainObject(after)) {
    return { ok: false, message: `设置 ${POOL_HOLDS_SETTING} 要是 {池编号: 条目}` };
  }
  const prior = isPlainObject(before) ? before : null;
  const value: Record<string, unknown> = {};
  for (const [poolId, entry] of Object.entries(after)) {
    if (poolId.length === 0) return { ok: false, message: '池编号不能留空' };
    const parsed = PoolHoldSchema.safeParse(entry);
    if (parsed.success) {
      value[poolId] = parsed.data;
      continue;
    }
    if (prior && Object.hasOwn(prior, poolId) && JSON.stringify(prior[poolId]) === JSON.stringify(entry)) {
      value[poolId] = prior[poolId];
      continue;
    }
    return {
      ok: false,
      message: `${poolId} 的暂停认不出（${issueText(parsed.error.issues[0])}）。已经在库里、原样没改的才能留着`,
    };
  }
  return { ok: true, value };
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
 * 还靠提醒顶着的列出来（额度页把封号、登录失效显示成「封号」，不自动改开关）。
 * opaque 带着认不出的原值：额度页改一个池时原样写回，不能只交认得出的。
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
    opaque: facts.opaque,
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
    : `撤回或改 ${touched.join('、')} 的暂停要写原因（撤回写为什么能撤了，续期写为什么还要停，改负责人写为什么换人）：这次改动没带 reason`;
}

/**
 * 到期的整池暂停拼成一条飞书正文（#954）。没到期的不写进去；一条都没有回 null（这一轮不推）。
 * 池名用池编号（库里没有另起的显示名）。去哪撤写驾驶舱额度页。没填复查日期的 hold 不是 overdue，不会进这条。
 */
export function overduePoolHoldPushText(
  holds: readonly Pick<
    PoolHoldFact,
    'poolId' | 'reason' | 'owner' | 'reviewBy' | 'overdue' | 'overdueDays'
  >[],
  today: string,
): string | null {
  const due = holds.filter((h) => h.overdue);
  if (due.length === 0) return null;
  const lines = due.map((h) => {
    const when = h.overdueDays === 0 ? '就是今天' : `已过 ${h.overdueDays} 天`;
    return `账号池 ${h.poolId}：原因：${h.reason}；负责人：${h.owner}；复查日期 ${h.reviewBy}（${when}）。`;
  });
  return [
    `整池暂停到了复查日期（今天 ${today}，北京时间）。`,
    ...lines,
    '引擎不会自动撤。到驾驶舱额度页打开这个池（要写原因），或改复查日期续期。',
  ].join('\n');
}
