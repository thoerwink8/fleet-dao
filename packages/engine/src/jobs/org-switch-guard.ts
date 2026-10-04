// 切号防来回抖（#194，specs/194-拼车自动切换/方案-v2.md 4.4、4.6、第六节第 1、5、10、15 条）。纯判法，还没接线：
// 切号（jobs/org-switch.ts）照旧到点就切回，接到切号上是后面的切片。
//
// 改这里之前必须知道：
// - 「证据说恢复了」（jobs/carpool-outage.ts 的 judgeCarpoolRecovery）和「现在能不能切回」是两层：这里只管后者——
//   最小停留、白切退避、切回预算、读不到时什么时候试探切回、在独享上待太久要人看、帮手切号失败的退避。
// - 切走（拼车被拒逼的）不设限；限住切回就限住了来回（Karpenter disruption budgets 同一个道理）。
// - 试探切回只认正面证据：切过去当场探、切回后第一批真请求；被拒就记一次白切。试探和确认过的切回一起算预算。
import type { CarpoolOutage, RecoveryVerdict } from './carpool-outage.ts';

export interface SwitchGuardPolicy {
  /** 切到独享后至少待这么久才考虑切回；E1 读数确认已恢复的不受这条限制（防的是 E2 不准的恢复时刻）。 */
  minStayMs: number;
  /** 切回拼车后这么久里又被拒，记一次白切。 */
  whiteWindowMs: number;
  /** 白切后下一次切回前多等的时长，按连着白切的次数取（翻倍、封顶）：第 1 次白切等第 1 档…… */
  backoffMs: readonly number[];
  /** 连着白切这么多次，推「要人看」、不再自己切回。 */
  stuckAfterWhites: number;
  /** 切回拼车后稳定跑满这么久，连着白切的次数清零。 */
  stableResetMs: number;
  /** 任意 budgetWindowMs 里自动切回不超过这么多次（确认过的、试探的都算）。 */
  switchBackBudget: number;
  budgetWindowMs: number;
  /** 过了预计恢复时刻这么久还挂在独享上，推「要人看」。 */
  overdueAlertMs: number;
  /** 接口读不到时，最后一次读到的恢复时刻过了这么久才试探切回。 */
  unreadableTrialAfterMs: number;
  /** 帮手切号连着失败后下一次多等的时长（第 1 次失败等第 1 档……封顶）。 */
  helperBackoffMs: readonly number[];
}

const MIN = 60_000;

export const DEFAULT_SWITCH_GUARD_POLICY: Readonly<SwitchGuardPolicy> = Object.freeze({
  minStayMs: 20 * MIN,
  whiteWindowMs: 15 * MIN,
  backoffMs: [15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN],
  stuckAfterWhites: 3,
  stableResetMs: 60 * MIN,
  switchBackBudget: 3,
  budgetWindowMs: 5 * 60 * MIN,
  overdueAlertMs: 30 * MIN,
  unreadableTrialAfterMs: 15 * MIN,
  helperBackoffMs: [2 * MIN, 10 * MIN, 30 * MIN],
});

/** 一次自动切回拼车（落库的切号记录里取）。trial = 试探切回（接口读不到、恢复时刻不知道时）。 */
export interface SwitchBack {
  at: Date;
  trial: boolean;
}

/** 切回之后的白切记账（落库，引擎重启后接着用）。 */
export interface WhiteStreak {
  /** 连着白切几次；稳定跑满 stableResetMs 清零。 */
  count: number;
  /** 最近一次白切的时刻。 */
  lastAt: Date | null;
  /** 最近一次白切是不是试探切回撞的。 */
  lastTrial: boolean;
}

export const NO_WHITES: Readonly<WhiteStreak> = Object.freeze({ count: 0, lastAt: null, lastTrial: false });

/**
 * 切回拼车后又被拒了：算不算白切、白切记账怎么变。超过 whiteWindowMs 才被拒的不算白切（拼车真用了一阵才满），
 * 记账清零（那一段已经稳定跑过）。
 */
export function recordRejectAfterSwitchBack(
  streak: WhiteStreak,
  back: SwitchBack,
  rejectedAt: Date,
  policy: SwitchGuardPolicy = DEFAULT_SWITCH_GUARD_POLICY,
): WhiteStreak {
  const gap = rejectedAt.getTime() - back.at.getTime();
  if (gap < 0) return streak;
  if (gap > policy.whiteWindowMs) return { ...NO_WHITES };
  return { count: streak.count + 1, lastAt: rejectedAt, lastTrial: back.trial };
}

/** 挂着拼车稳定跑满 stableResetMs（从最近一次切回算，期间没被拒）：清零。 */
export function settleWhiteStreak(
  streak: WhiteStreak,
  lastBack: SwitchBack | null,
  now: Date,
  policy: SwitchGuardPolicy = DEFAULT_SWITCH_GUARD_POLICY,
): WhiteStreak {
  if (streak.count === 0 || !lastBack) return streak;
  if (streak.lastAt && streak.lastAt.getTime() > lastBack.at.getTime()) return streak;
  return now.getTime() - lastBack.at.getTime() >= policy.stableResetMs ? { ...NO_WHITES } : streak;
}

/**
 * 白切之后最早几点能再切回。试探切回撞的白切从第二档起算（方案第六节第 1、5 条：试探又被拒，30 分钟后才再试）——
 * 试探本来就是没有读数时的猜，猜错一次就多退一档；确认过的切回从第一档（15 分钟，4.6）。
 */
export function backoffUntil(
  streak: WhiteStreak,
  policy: SwitchGuardPolicy = DEFAULT_SWITCH_GUARD_POLICY,
): Date | null {
  if (streak.count === 0 || !streak.lastAt) return null;
  const tiers = policy.backoffMs;
  const idx = Math.min(streak.count - 1 + (streak.lastTrial ? 1 : 0), tiers.length - 1);
  return new Date(streak.lastAt.getTime() + (tiers[idx] ?? 0));
}

export interface SwitchBackFacts {
  /** 切走时落库的「拼车恢复条件」（之后读到新读数会更新 resetsAt）。 */
  outage: CarpoolOutage;
  /** 证据层的结论（judgeCarpoolRecovery）。 */
  recovery: RecoveryVerdict;
  /** 这一次切到独享的时刻。 */
  onSoloSince: Date;
  /** 最近 budgetWindowMs 以内（多给也行）的自动切回。 */
  recentBacks: readonly SwitchBack[];
  whites: WhiteStreak;
  /** 接口最近一次读成的时刻；从没读成为 null。 */
  lastApiOkAt: Date | null;
  now: Date;
}

/**
 * 现在能不能切回拼车：
 * - go：切回（confirmed 有正面读数；trial 读不到、按退避试探，切过去当场探、看第一批真请求）；
 * - hold：这一轮不切，until 是最早几点再看（不知道为 null，下一轮再判）；
 * - stuck：不再自己切回，推「要人看」（连着白切到上限、切回预算用完）。
 * 不管哪一种，overdue 给了就另推一条「在独享上待太久」（过了预计恢复时刻 30 分钟还没切回）。
 */
export type SwitchBackDecision = (
  | { action: 'go'; mode: 'confirmed' | 'trial'; why: string }
  | { action: 'hold'; why: string; until: Date | null }
  | { action: 'stuck'; why: string }
) & { overdue?: string };

export function decideSwitchBack(
  facts: SwitchBackFacts,
  policy: SwitchGuardPolicy = DEFAULT_SWITCH_GUARD_POLICY,
): SwitchBackDecision {
  const d = decide(facts, policy);
  const overdue = overdueNote(facts, d, policy);
  return overdue ? { ...d, overdue } : d;
}

function decide(f: SwitchBackFacts, policy: SwitchGuardPolicy): SwitchBackDecision {
  const now = f.now.getTime();
  if (f.whites.count >= policy.stuckAfterWhites) {
    return {
      action: 'stuck',
      why: `切回拼车后马上又被拒，连着 ${f.whites.count} 次了：不再自己切回，要人看拼车到底能不能用`,
    };
  }
  const inWindow = f.recentBacks.filter((b) => now - b.at.getTime() < policy.budgetWindowMs);
  if (inWindow.length >= policy.switchBackBudget) {
    return {
      action: 'stuck',
      why: `${Math.round(policy.budgetWindowMs / 3_600_000)} 小时里已经自动切回 ${inWindow.length} 次，预算用完：留在独享，要人看`,
    };
  }
  const backoff = backoffUntil(f.whites, policy);
  if (backoff && backoff.getTime() > now) {
    return { action: 'hold', why: `上一次切回是白切，退避到 ${stamp(backoff)} 再试`, until: backoff };
  }
  const stayUntil = f.onSoloSince.getTime() + policy.minStayMs;
  const r = f.recovery;
  if (r.state === 'recovered') {
    if (f.outage.kind === 'E1') return { action: 'go', mode: 'confirmed', why: r.why };
    if (now < stayUntil) {
      return {
        action: 'hold',
        why: `${r.why}；切到独享还不到最小停留，${stamp(new Date(stayUntil))} 再切回`,
        until: new Date(stayUntil),
      };
    }
    return { action: 'go', mode: 'confirmed', why: r.why };
  }
  if (r.state === 'not-yet') {
    return { action: 'hold', why: r.why, until: r.at && r.at.getTime() > now ? r.at : null };
  }
  // unknown：没有新读数（接口读不成）、或 E2 不知道几点恢复。只在有个「该恢复了」的时刻之后才试探。
  if (now < stayUntil) {
    return {
      action: 'hold',
      why: `${r.why}；切到独享还不到最小停留，${stamp(new Date(stayUntil))} 以后再考虑试探`,
      until: new Date(stayUntil),
    };
  }
  const resetsAt = f.outage.resetsAt;
  const apiDown = f.lastApiOkAt === null || f.lastApiOkAt.getTime() < f.outage.since.getTime();
  if (resetsAt && apiDown) {
    const trialAt = resetsAt.getTime() + policy.unreadableTrialAfterMs;
    if (now < trialAt) {
      return {
        action: 'hold',
        why: `${r.why}；接口读不到，等到预计恢复时刻之后 ${Math.round(policy.unreadableTrialAfterMs / MIN)} 分钟（${stamp(new Date(trialAt))}）再试探切回`,
        until: new Date(trialAt),
      };
    }
    return { action: 'go', mode: 'trial', why: `接口读不到（${r.why}），过了预计恢复时刻，试探切回` };
  }
  if (!resetsAt) {
    return { action: 'go', mode: 'trial', why: `${r.why}；过了最小停留，试探切回` };
  }
  // 有恢复时刻、接口也读成过，只是被拒之后的读数全是缓存：等下一次真新读数
  return { action: 'hold', why: r.why, until: null };
}

function overdueNote(
  f: SwitchBackFacts,
  d: SwitchBackDecision,
  policy: SwitchGuardPolicy,
): string | undefined {
  if (d.action === 'go') return undefined;
  const expected = f.outage.resetsAt ?? new Date(f.onSoloSince.getTime() + policy.minStayMs);
  const late = f.now.getTime() - expected.getTime();
  if (late <= policy.overdueAlertMs) return undefined;
  return `过了预计恢复时刻（${stamp(expected)}）${Math.round(late / MIN)} 分钟还挂在独享上，卡在：${d.why}`;
}

/**
 * 帮手切号连着失败后（方案第六节第 10 条），下一次最早几点能再试：第 1 次失败等 2 分钟、第 2 次 10 分钟、之后 30 分钟。
 * failures 是从最近一次成功之后的连续失败时刻（成功一次就清空）。
 */
export function helperRetryAt(
  failures: readonly Date[],
  policy: SwitchGuardPolicy = DEFAULT_SWITCH_GUARD_POLICY,
): Date | null {
  if (failures.length === 0) return null;
  const last = Math.max(...failures.map((d) => d.getTime()));
  const tiers = policy.helperBackoffMs;
  const wait = tiers[Math.min(failures.length - 1, tiers.length - 1)] ?? 0;
  return new Date(last + wait);
}

const stamp = (d: Date) => `${d.toISOString().replace('T', ' ').slice(0, 16)}（UTC）`;
