// 名额按错误预算分（specs/3582-自身诊断/诊断.md 第五节）：每日简报算出的档位和每项现值，写在设置表 engine.selfShare 一行，拉单读它。
// 读不到、认不出照抛，不拿「健康」顶；没有这一行（简报还没算过）回 null。

import { and, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { notifications, settings } from '../schema/index.ts';

export const SELF_SHARE_SETTING = 'engine.selfShare';
/** 滚动窗口天数。 */
export const SELF_SHARE_WINDOW_DAYS = 7;

export const SELF_SHARE_TIERS = ['healthy', 'spending', 'frozen'] as const;
export type SelfShareTier = (typeof SELF_SHARE_TIERS)[number];

/** 五项判据：一轮做成率、冷验收拒绝占比、主线 CI 红分钟、机器开的自身缺陷单张数、非掏钱非删数据原因的拍板卡张数。 */
export const SELF_SHARE_ITEM_KEYS = [
  'oneRoundRate',
  'verifyReject',
  'ciRedMinutes',
  'selfDefects',
  'offReasonDecisions',
] as const;
export type SelfShareItemKey = (typeof SELF_SHARE_ITEM_KEYS)[number];

export interface SelfShareItem {
  key: SelfShareItemKey;
  /** 现值；读不到是 null（按没过算）。 */
  value: number | null;
  passed: boolean;
  /** 读不到的原因。 */
  unread?: string;
}

export interface SelfShareDay {
  /** 北京日期 YYYY-MM-DD。 */
  day: string;
  /** 这一天 5 项是否都过。 */
  allPass: boolean;
}

export interface SelfShareRow {
  tier: SelfShareTier;
  /** 算的是哪一天（北京日期）的简报。 */
  day: string;
  at: Date;
  items: SelfShareItem[];
  /** 连续几天 5 项都过（含今天；今天没全过是 0）。 */
  streak: number;
  /** 最近几天每天是否全过，老的在前；算连续天数用。 */
  history: SelfShareDay[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(why: string, value: unknown): never {
  throw new Error(`设置 ${SELF_SHARE_SETTING} 的值认不出（${why}）：${JSON.stringify(value)}`);
}

/** 设置表里的原值 → SelfShareRow。形状不对照抛。 */
export function parseSelfShare(raw: unknown): SelfShareRow {
  const v = raw as {
    tier?: unknown;
    day?: unknown;
    at?: unknown;
    items?: unknown;
    streak?: unknown;
    history?: unknown;
  } | null;
  if (typeof v !== 'object' || v === null) return bad('不是对象', raw);
  if (!(SELF_SHARE_TIERS as readonly unknown[]).includes(v.tier)) return bad('档位不对', raw);
  if (typeof v.day !== 'string' || !DAY_RE.test(v.day)) return bad('day 不是日期', raw);
  const at = typeof v.at === 'string' ? new Date(v.at) : null;
  if (at === null || Number.isNaN(at.getTime())) return bad('at 不是时间', raw);
  if (!Array.isArray(v.items)) return bad('items 不是数组', raw);
  if (typeof v.streak !== 'number' || !Number.isInteger(v.streak) || v.streak < 0) {
    return bad('streak 不是非负整数', raw);
  }
  if (!Array.isArray(v.history)) return bad('history 不是数组', raw);
  const items = v.items.map((i: unknown): SelfShareItem => {
    const it = i as { key?: unknown; value?: unknown; passed?: unknown; unread?: unknown };
    if (
      !(SELF_SHARE_ITEM_KEYS as readonly unknown[]).includes(it?.key) ||
      !(it.value === null || (typeof it.value === 'number' && Number.isFinite(it.value))) ||
      typeof it.passed !== 'boolean' ||
      !(it.unread === undefined || typeof it.unread === 'string')
    ) {
      return bad('items 里有一项认不出', raw);
    }
    return {
      key: it.key as SelfShareItemKey,
      value: it.value as number | null,
      passed: it.passed,
      ...(typeof it.unread === 'string' ? { unread: it.unread } : {}),
    };
  });
  const history = v.history.map((h: unknown): SelfShareDay => {
    const d = h as { day?: unknown; allPass?: unknown };
    if (typeof d?.day !== 'string' || !DAY_RE.test(d.day) || typeof d.allPass !== 'boolean') {
      return bad('history 里有一项认不出', raw);
    }
    return { day: d.day, allPass: d.allPass };
  });
  return { tier: v.tier as SelfShareTier, day: v.day, at, items, streak: v.streak, history };
}

/** 读。没有这一行回 null；认不出照抛。 */
export async function readSelfShare(db: Db): Promise<SelfShareRow | null> {
  const rows = await db.select().from(settings).where(sql`${settings.key} = ${SELF_SHARE_SETTING}`);
  const row = rows[0];
  return row ? parseSelfShare(row.value) : null;
}

/** 写（有就换、没有就建，版本加 1）。 */
export async function writeSelfShare(db: Db, row: SelfShareRow, by: string): Promise<void> {
  const value = { ...row, at: row.at.toISOString() };
  await db
    .insert(settings)
    .values({ key: SELF_SHARE_SETTING, value, updatedBy: by })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedBy: by, version: sql`${settings.version} + 1` },
    });
}

/**
 * 窗口 [to − 7 天, to) 里新开的「要你拍」卡，原因既不是掏新钱也不是删了找不回的张数（即 human-only；原因空的老卡也算，
 * 分不出就不当成合规）。第五节第 2 条：只为掏钱、删了找不回停下问人，其余都是多打扰。
 */
export async function offReasonDecisionCount(db: Db, to: Date): Promise<number> {
  if (Number.isNaN(to.getTime())) throw new Error('offReasonDecisionCount: 时刻不是有效日期');
  const from = new Date(to.getTime() - SELF_SHARE_WINDOW_DAYS * 86_400_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        sql`${notifications.level} = 'decision'`,
        gte(notifications.createdAt, from),
        lt(notifications.createdAt, to),
        sql`(${notifications.decisionReason} is null or ${notifications.decisionReason} not in ('new-money', 'irreversible-delete'))`,
      ),
    );
  return Number(row?.n ?? 0);
}
