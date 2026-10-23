// 名额按错误预算分（specs/3582-自身诊断/诊断.md 第五节；参照 Google SRE 错误预算）：系统不健康先修自己，健康时把名额让给真实项目。
// 这里只放纯函数：每日简报（jobs/daily-brief.ts）拿滚动 7 天的五项现值算一次档位写进设置表 engine.selfShare，拉单（jobs/intake.ts）读它分名额。
//
// 判据（滚动 7 天，每项都有一个「过」的线）：
//   一轮做成率 ≥ 40%；冷验收拒绝占比 ≤ 15%；主线 CI 红 ≤ 60 分钟；机器开的自身缺陷单 ≤ 30 张；非掏钱非删数据原因的拍板卡 = 0。
// 分档：
//   健康＝5 项都过，且连续 3 天（含今天）都是 5 项全过；
//   耗预算＝恰好 1 项没过，且不是 CI 红那项；
//   冻结＝其余的（2 项以上没过、只有 CI 红没过、5 项都过但还没连续 3 天）。
// 任何一项读不到（值是 null）按「没过」算，不当成过。

import type {
  SelfShareDay,
  SelfShareItem,
  SelfShareItemKey,
  SelfShareRow,
  SelfShareTier,
} from '@fleet-dao/db';

/** fleet-dao 自己这个仓的名字（和驾驶舱 self-repo.ts 同一个认法）。 */
export const SELF_REPO_NAME = 'fleet-dao';

/** 每一项的线：min 是「至少」，max 是「至多」。 */
export const SELF_SHARE_LINES: Record<
  SelfShareItemKey,
  { bound: 'min' | 'max'; limit: number; label: string; unit: string }
> = {
  oneRoundRate: { bound: 'min', limit: 0.4, label: '一轮做成率', unit: '%' },
  verifyReject: { bound: 'max', limit: 0.15, label: '冷验收拒绝占比', unit: '%' },
  ciRedMinutes: { bound: 'max', limit: 60, label: '主线 CI 红', unit: ' 分钟' },
  selfDefects: { bound: 'max', limit: 30, label: '机器开的自身缺陷单', unit: ' 张' },
  offReasonDecisions: { bound: 'max', limit: 0, label: '非掏钱非删数据原因的拍板卡', unit: ' 张' },
};

/** 连续几天 5 项全过才算健康。 */
export const SELF_SHARE_HEALTHY_DAYS = 3;
/** history 最多留几天。 */
const HISTORY_KEEP = 14;
/** 档位超过这么久没更新（简报停了）就当读不到：免得冻结的结论永远停在那里。 */
export const SELF_SHARE_STALE_MS = 72 * 3_600_000;

/** 一项读到的现值；读不到 value 是 null，unread 写原因。 */
export interface SelfShareReading {
  value: number | null;
  unread?: string;
}

export type SelfShareReadings = Record<SelfShareItemKey, SelfShareReading>;

const KEYS = Object.keys(SELF_SHARE_LINES) as SelfShareItemKey[];

function passes(key: SelfShareItemKey, value: number | null): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  const line = SELF_SHARE_LINES[key];
  return line.bound === 'min' ? value >= line.limit : value <= line.limit;
}

/** 'YYYY-MM-DD' 的前一天。 */
function previousDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`日期认不出：${day}`);
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

/**
 * 按五项现值和前几天的记录算今天的档位。day 是北京日期；previous 是上次存下的每天记录（可含今天：同一天重算会换掉今天那条）。
 * 连续天数只数日期相邻的：中间缺一天（简报那天没算成）就断。
 */
export function computeSelfShare(input: {
  readings: SelfShareReadings;
  day: string;
  previous: readonly SelfShareDay[];
  at: Date;
}): SelfShareRow {
  const items: SelfShareItem[] = KEYS.map((key) => {
    const r = input.readings[key];
    const value = r.value !== null && Number.isFinite(r.value) ? r.value : null;
    const unread = value === null ? (r.unread ?? '没读到') : undefined;
    return { key, value, passed: passes(key, value), ...(unread !== undefined ? { unread } : {}) };
  });
  const failed = items.filter((i) => !i.passed).map((i) => i.key);
  const allPass = failed.length === 0;
  const history = [...input.previous.filter((d) => d.day !== input.day), { day: input.day, allPass }]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-HISTORY_KEEP);
  const passDays = new Set(history.filter((d) => d.allPass).map((d) => d.day));
  let streak = 0;
  for (let d = input.day; passDays.has(d); d = previousDay(d)) streak += 1;
  let tier: SelfShareTier;
  if (allPass) tier = streak >= SELF_SHARE_HEALTHY_DAYS ? 'healthy' : 'frozen';
  else if (failed.length === 1 && failed[0] !== 'ciRedMinutes') tier = 'spending';
  else tier = 'frozen';
  return { tier, day: input.day, at: input.at, items, streak, history };
}

/** 每档 fleet-dao 自身单最多占在跑名额的几成；冻结不按成数限（自身单不限、别的仓不拉）。 */
export const SELF_SHARE_RATIO: Record<SelfShareTier, number | null> = {
  healthy: 0.3,
  spending: 0.5,
  frozen: null,
};

/** fleet-dao 自身单最多同时在跑几条；null＝这一档不按成数限。至少 1 条（名额太少时不把自己整个堵死）。 */
export function selfShareCap(tier: SelfShareTier, maxRunning: number): number | null {
  const ratio = SELF_SHARE_RATIO[tier];
  return ratio === null ? null : Math.max(1, Math.floor(maxRunning * ratio));
}

/** 别的仓此刻能不能拉新单：冻结不能（在跑的照跑）。 */
export function othersMayPull(tier: SelfShareTier): boolean {
  return tier !== 'frozen';
}

export const SELF_SHARE_TIER_WORDS: Record<SelfShareTier, string> = {
  healthy: '健康',
  spending: '耗预算',
  frozen: '冻结',
};

/** 一档的名额规矩，一句白话（简报用）。 */
export function selfShareRule(tier: SelfShareTier): string {
  if (tier === 'healthy') return 'fleet-dao 自身单最多占在跑名额的 30%，其余让给真实项目';
  if (tier === 'spending') return 'fleet-dao 自身单最多占在跑名额的 50%';
  return '只拉 fleet-dao 自身单，别的仓不拉新单（在跑的照跑）';
}

/** 一项的现值写成人话。 */
export function selfShareValueText(item: Pick<SelfShareItem, 'key' | 'value'>): string {
  if (item.value === null) return '读不到';
  const line = SELF_SHARE_LINES[item.key];
  return line.unit === '%'
    ? `${Math.round(item.value * 1000) / 10}%`
    : `${Math.round(item.value * 10) / 10}${line.unit}`;
}

/** 一项的线写成人话。 */
export function selfShareLineText(key: SelfShareItemKey): string {
  const line = SELF_SHARE_LINES[key];
  const n = line.unit === '%' ? `${Math.round(line.limit * 100)}%` : `${line.limit}${line.unit}`;
  return `${line.bound === 'min' ? '≥' : line.limit === 0 ? '=' : '≤'} ${n}`;
}
