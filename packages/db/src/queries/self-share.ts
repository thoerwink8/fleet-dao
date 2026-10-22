// 名额按错误预算分（#3618，母单 #3582 第五节）：每日简报算一次档位写进设置表 engine.selfShare，拉单（intake）读它分名额。
// 这里放：这一行设置的形状和读写、判档要的两项库里指标（主线 CI 红了多少分钟、非掏钱非删数据原因的拍板卡有几张）。
// 一轮做成率、冷验收拒绝占比用 pipeline-health.ts 现成的口径；机器开的自身缺陷单要读 GitHub，不在这里。
// 读不到照抛，不拿 0 顶（判档那头读不到按「没过」算）；这一行认不出（形状不对）也照抛，不当成「没有档位」。
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { notifications, settings } from '../schema/index.ts';
import { FEISHU_MAIN_RED_KEY_PREFIX } from './feishu-push.ts';

export const SELF_SHARE_SETTING = 'engine.selfShare';

export const SELF_SHARE_TIERS = ['healthy', 'budget', 'frozen'] as const;
/** 健康：fleet-dao 自身单最多占在跑名额 30%；耗预算：50%；冻结：只拉 fleet-dao 自身单。 */
export type SelfShareTier = (typeof SELF_SHARE_TIERS)[number];

export const SELF_SHARE_CHECK_KEYS = [
  'oneRoundRate',
  'verifyRejectShare',
  'mainRedMinutes',
  'selfDefectIssues',
  'offReasonDecisions',
] as const;
export type SelfShareCheckKey = (typeof SELF_SHARE_CHECK_KEYS)[number];

/** 一项指标的现值和过没过；value 为 null ＝ 读不到（按没过算）。 */
export interface SelfShareCheck {
  key: SelfShareCheckKey;
  value: number | null;
  pass: boolean;
}

/** engine.selfShare 那一行：当天的档位、每项现值，加最近几天每天五项是否都过（算「连续 3 天」用）。 */
export interface SelfShareRecord {
  tier: SelfShareTier;
  /** 算这一档的时刻。 */
  at: Date;
  /** 算这一档的北京日期（YYYY-MM-DD）。 */
  day: string;
  checks: SelfShareCheck[];
  days: { day: string; allPass: boolean }[];
}

const isTier = (v: unknown): v is SelfShareTier => (SELF_SHARE_TIERS as readonly unknown[]).includes(v);
const isKey = (v: unknown): v is SelfShareCheckKey =>
  (SELF_SHARE_CHECK_KEYS as readonly unknown[]).includes(v);

/** 把设置表里的原值认成 SelfShareRecord；形状不对抛错（带原值），不猜。 */
export function parseSelfShare(value: unknown): SelfShareRecord {
  const bad = () => new Error(`设置 ${SELF_SHARE_SETTING} 的值认不出：${JSON.stringify(value)}`);
  const v = value as {
    tier?: unknown;
    at?: unknown;
    day?: unknown;
    checks?: unknown;
    days?: unknown;
  } | null;
  const at = typeof v?.at === 'string' ? new Date(v.at) : null;
  if (!v || !isTier(v.tier) || at === null || Number.isNaN(at.getTime()) || typeof v.day !== 'string') {
    throw bad();
  }
  if (!Array.isArray(v.checks) || !Array.isArray(v.days)) throw bad();
  const checks = v.checks.map((c: { key?: unknown; value?: unknown; pass?: unknown }) => {
    if (!isKey(c?.key) || typeof c.pass !== 'boolean') throw bad();
    if (c.value !== null && typeof c.value !== 'number') throw bad();
    return { key: c.key, value: c.value, pass: c.pass } satisfies SelfShareCheck;
  });
  const days = v.days.map((d: { day?: unknown; allPass?: unknown }) => {
    if (typeof d?.day !== 'string' || typeof d.allPass !== 'boolean') throw bad();
    return { day: d.day, allPass: d.allPass };
  });
  return { tier: v.tier, at, day: v.day, checks, days };
}

/** 读。没这一行是 null（还没算过）；认不出照抛。 */
export async function readSelfShare(db: Db): Promise<SelfShareRecord | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SELF_SHARE_SETTING));
  return row ? parseSelfShare(row.value) : null;
}

/** 写（有就换、没有就建，版本加 1）。 */
export async function writeSelfShare(db: Db, rec: SelfShareRecord, by: string): Promise<void> {
  const value = { ...rec, at: rec.at.toISOString() };
  await db
    .insert(settings)
    .values({ key: SELF_SHARE_SETTING, value, updatedBy: by })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedBy: by, version: sql`${settings.version} + 1` },
    });
}

/**
 * 区间并起来、截到 [from, to) 里，一共多少分钟（同一时刻两张主线红提醒都开着只算一次）。
 * end 为 null ＝ 还开着，算到 to。
 */
export function redMinutes(
  intervals: readonly { start: Date; end: Date | null }[],
  from: Date,
  to: Date,
): number {
  const clipped = intervals
    .map((i) => ({
      s: Math.max(i.start.getTime(), from.getTime()),
      e: Math.min((i.end ?? to).getTime(), to.getTime()),
    }))
    .filter((i) => i.e > i.s)
    .sort((a, b) => a.s - b.s);
  let total = 0;
  let curEnd = Number.NEGATIVE_INFINITY;
  for (const i of clipped) {
    const s = Math.max(i.s, curEnd);
    if (i.e > s) total += i.e - s;
    curEnd = Math.max(curEnd, i.e);
  }
  return Math.round(total / 60_000);
}

/**
 * 窗口 [to - 7 天, to) 里主线 CI 红了多少分钟：引擎的「主线红了」提醒（feishu:main-red:<sha>）从建出到撤掉（主线转绿时撤），
 * 还开着的算到 to，几张重叠的并起来只算一次。
 */
export async function mainRedMinutes(db: Db, to: Date, days = 7): Promise<number> {
  const from = new Date(to.getTime() - days * 86_400_000);
  const rows = await db
    .select({ start: notifications.createdAt, end: notifications.resolvedAt })
    .from(notifications)
    .where(
      and(
        sql`starts_with(${notifications.dedupeKey}, ${FEISHU_MAIN_RED_KEY_PREFIX})`,
        sql`${notifications.createdAt} < ${to.toISOString()}::timestamptz`,
        sql`(${notifications.resolvedAt} is null or ${notifications.resolvedAt} > ${from.toISOString()}::timestamptz)`,
      ),
    );
  return redMinutes(rows, from, to);
}

/** 现在开着的、原因不是「掏新钱」「删了找不回」（即只有人能做）的拍板卡有几张。 */
export async function offReasonDecisions(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.level, 'decision'),
        isNull(notifications.resolvedAt),
        notInArray(notifications.decisionReason, ['new-money', 'irreversible-delete']),
      ),
    );
  return Number(row?.n ?? 0);
}
