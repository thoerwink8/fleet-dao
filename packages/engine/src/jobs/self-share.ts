// 名额按错误预算分（#3618，母单 #3582 第五节；参照 Google SRE 错误预算）：系统不健康先修自己，健康时把名额让给真实项目。
// 每日简报（jobs/daily-brief.ts）算一次档位写进设置表 engine.selfShare（库那头在 @fleet-dao/db 的 queries/self-share.ts），
// 拉单（jobs/intake.ts）读它给 fleet-dao 自身单留名额。这里放不碰库、不碰 GitHub 的部分：判档、档位对应的名额、读到的档位还能不能信。
//
// 判档（滚动 7 天的五项）：一轮做成率 ≥ 40%、冷验收拒绝占比 ≤ 15%、主线 CI 红 ≤ 60 分钟、机器开的自身缺陷单 ≤ 30 张、
// 非掏钱非删数据原因的拍板卡 = 0。
// - 5 项都过且连续 3 天（今天算一天）＝健康；
// - 只 1 项没过、且不是 CI 红那项＝耗预算；
// - 其余＝冻结：CI 红没过、2 项以上没过，以及五项都过但还没连续 3 天
//   （刚恢复、或刚上线没有历史。没有连续 3 天的证据，不把名额让出去）。
// - 任何一项读不到（null、不是有限数）按「没过」算。
import {
  SELF_SHARE_CHECK_KEYS,
  type SelfShareCheck,
  type SelfShareCheckKey,
  type SelfShareRecord,
  type SelfShareTier,
} from '@fleet-dao/db';

/** fleet-dao 自己这个仓：在受管的仓里按名字认（和驾驶舱 self-repo.ts 同一个认法），owner 不写死。 */
export const SELF_REPO_NAME = 'fleet-dao';

/** 连续几天五项都过才算健康。 */
export const SELF_SHARE_HEALTHY_DAYS = 3;
/** 档位超过多久没更新就不信（简报断了几天，不能让旧的冻结把真实项目一直挡着）。 */
export const SELF_SHARE_STALE_MS = 3 * 86_400_000;
/** 设置里最多留几天的逐日结论。 */
const KEEP_DAYS = 7;

/** 每一项的门槛和说明。pass 里 value 一定是有限数。 */
export const SELF_SHARE_CRITERIA: Record<
  SelfShareCheckKey,
  { label: string; rule: string; unit: string; pass(value: number): boolean; percent?: true }
> = {
  oneRoundRate: { label: '一轮做成率', rule: '≥ 40%', unit: '', pass: (v) => v >= 0.4, percent: true },
  verifyRejectShare: {
    label: '冷验收拒绝占比',
    rule: '≤ 15%',
    unit: '',
    pass: (v) => v <= 0.15,
    percent: true,
  },
  mainRedMinutes: { label: '主线 CI 红', rule: '≤ 60 分钟', unit: ' 分钟', pass: (v) => v <= 60 },
  selfDefectIssues: { label: '机器开的自身缺陷单', rule: '≤ 30 张', unit: ' 张', pass: (v) => v <= 30 },
  offReasonDecisions: {
    label: '非掏钱非删数据原因的拍板卡',
    rule: '= 0',
    unit: ' 张',
    pass: (v) => v === 0,
  },
};

/** 五项现值；null ＝ 读不到。 */
export type SelfShareMetrics = Record<SelfShareCheckKey, number | null>;

export const SELF_SHARE_TIER_WORDS: Record<SelfShareTier, string> = {
  healthy: '健康',
  budget: '耗预算',
  frozen: '冻结',
};

const DAY_MS = 86_400_000;
const dayBefore = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

/** day 当天往前连着几天五项都过（含 day 这一天，days 里要有它）。 */
export function healthyStreak(days: readonly { day: string; allPass: boolean }[], day: string): number {
  const byDay = new Map(days.map((d) => [d.day, d.allPass] as const));
  let n = 0;
  while (byDay.get(dayBefore(day, n)) === true) n += 1;
  return n;
}

/**
 * 判档。history 是此前每天的结论（设置里存的 days；同一天已经有就换成这次的，手动再跑一次不重复记）。
 * day 是算这一档的北京日期。纯函数：不读库、不看时钟（at 只是原样写进结果）。
 */
export function judgeSelfShare(
  metrics: SelfShareMetrics,
  history: readonly { day: string; allPass: boolean }[],
  day: string,
  at: Date,
): SelfShareRecord {
  const checks: SelfShareCheck[] = SELF_SHARE_CHECK_KEYS.map((key) => {
    const raw = metrics[key];
    const value = raw !== null && Number.isFinite(raw) ? raw : null;
    return { key, value, pass: value !== null && SELF_SHARE_CRITERIA[key].pass(value) };
  });
  const failed = checks.filter((c) => !c.pass);
  const allPass = failed.length === 0;
  const days = [...history.filter((d) => d.day !== day), { day, allPass }]
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-KEEP_DAYS);
  let tier: SelfShareTier;
  if (allPass && healthyStreak(days, day) >= SELF_SHARE_HEALTHY_DAYS) tier = 'healthy';
  else if (failed.length === 1 && failed[0]?.key !== 'mainRedMinutes') tier = 'budget';
  else tier = 'frozen';
  return { tier, at, day, checks, days };
}

/** 一档在拉单上的限制：selfCap ＝ fleet-dao 自身单最多占几条在跑名额（null ＝ 不另限）；othersAllowed ＝ 别的仓能不能拉新单。 */
export interface SelfShareLimits {
  selfCap: number | null;
  othersAllowed: boolean;
}

const SELF_SHARE_RATIO = { healthy: 0.3, budget: 0.5 } as const;

/**
 * 档位对应的名额。健康 30%、耗预算 50%，按同时在跑上限向下取整，至少留 1 条（不然 6 条上限的 30% 取整后自身单永远进不去）；
 * 冻结：自身单不另限、别的仓不拉新单（在跑的照跑，这里不管）。
 */
export function selfShareLimits(tier: SelfShareTier, maxRunning: number): SelfShareLimits {
  if (tier === 'frozen') return { selfCap: null, othersAllowed: false };
  return { selfCap: Math.max(1, Math.floor(maxRunning * SELF_SHARE_RATIO[tier])), othersAllowed: true };
}

/**
 * 读到的档位能不能用于这一轮拉单：没有（还没算过）、时刻认不出、超过 SELF_SHARE_STALE_MS 没更新，都回原因（调用方记一条日志、照现行行为拉单）。
 * 能用回 null。
 */
export function selfShareUnusable(rec: Pick<SelfShareRecord, 'at'> | null, now: Date): string | null {
  if (rec === null) return '设置里还没有档位（每日简报还没算过）';
  const age = now.getTime() - rec.at.getTime();
  if (Number.isNaN(age)) return '档位的时刻认不出';
  if (age > SELF_SHARE_STALE_MS) {
    return `档位已经 ${Math.round(age / 3_600_000)} 小时没更新（超过 ${SELF_SHARE_STALE_MS / 3_600_000} 小时不信）`;
  }
  return null;
}

/** 某一项现值的白话：读不到写「读不到」。 */
export function selfShareValueText(c: SelfShareCheck): string {
  if (c.value === null) return '读不到';
  const k = SELF_SHARE_CRITERIA[c.key];
  return k.percent ? `${Math.round(c.value * 100)}%` : `${c.value}${k.unit}`;
}

/** 简报「名额」一节的几行：档位加限制、每项现值和门槛、连续几天五项都过。 */
export function selfShareLines(rec: SelfShareRecord): string[] {
  const rule =
    rec.tier === 'frozen'
      ? '只拉 fleet-dao 自身单，其他仓不拉新单（在跑的照跑）'
      : `fleet-dao 自身单最多占在跑名额的 ${rec.tier === 'healthy' ? '30%' : '50%'}，其余留给真实项目`;
  const lines = [`档位：${SELF_SHARE_TIER_WORDS[rec.tier]}；${rule}`];
  for (const c of rec.checks) {
    const k = SELF_SHARE_CRITERIA[c.key];
    lines.push(`· ${k.label}：${selfShareValueText(c)}（要求 ${k.rule}）${c.pass ? '过' : '没过'}`);
  }
  lines.push(
    `五项都过已连续 ${healthyStreak(rec.days, rec.day)} 天（连续 ${SELF_SHARE_HEALTHY_DAYS} 天才算健康）`,
  );
  return lines;
}
