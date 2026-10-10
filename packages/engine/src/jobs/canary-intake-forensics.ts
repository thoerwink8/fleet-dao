// #1773：把「收单」断链的公开旁证收成可核对的分类，避免只凭猜测写根因。
// 20:46 那轮的硬证据来自 GitHub 巡检仓公开时间线（不依赖法国库 / SSH）：
//   https://github.com/thoerwink8/fleet-dao-canary/issues/83
//   https://github.com/thoerwink8/fleet-dao-canary/pull/84

/** 一轮「断在收单」的旁证（时刻一律 UTC ISO）。 */
export interface CanaryIntakeBreakEvidence {
  /** 巡检开单时刻。 */
  openedAt: string;
  /** healthz / canary_runs 有结论「断在收单」的时刻（与开单间隔应约等于收单期限）。 */
  brokenAt: string;
  /** 引擎第一次为这张单开出 PR 的时刻（证明稍后仍被拉起）。 */
  firstEnginePrAt: string;
  /** 单子做完关掉的时刻（state_reason=completed）。 */
  closedCompletedAt: string;
  /** 开单机器人。 */
  openedBy: string;
  /** 收单期限（分钟），与 CANARY_STAGE_LIMIT_MINUTES.intake 一致。 */
  intakeLimitMinutes: number;
}

export type CanaryIntakeBreakClass =
  | 'master_off'
  | 'dispatch_off'
  | 'untrusted_or_brief'
  | 'breaker_all_window'
  | 'empty_source'
  | 'intake_slot_delay'
  | 'unknown';

export interface CanaryIntakeBreakVerdict {
  class: CanaryIntakeBreakClass;
  /** 给人看的一句结论。 */
  why: string;
  /** 已排除的类别。 */
  ruledOut: CanaryIntakeBreakClass[];
}

const ENGINE_BOT = 'fleet-dao-engine[bot]';

/**
 * 只凭公开时间线分类：能排除的写进 ruledOut，剩「收单空位延误」或 unknown。
 * 不猜库里的 why 原文；有 PR、做完关单就证明不是开关/白名单/交代/整窗熔断。
 */
export function classifyCanaryIntakeBreak(e: CanaryIntakeBreakEvidence): CanaryIntakeBreakVerdict {
  const opened = Date.parse(e.openedAt);
  const broken = Date.parse(e.brokenAt);
  const prAt = Date.parse(e.firstEnginePrAt);
  const closed = Date.parse(e.closedCompletedAt);
  if (![opened, broken, prAt, closed].every(Number.isFinite)) {
    return { class: 'unknown', why: '旁证时刻认不出', ruledOut: [] };
  }
  const ruledOut: CanaryIntakeBreakClass[] = [];
  // 开了单且引擎机器人开的：总开关当时开着（关着 canary 定时任务整轮不跑、不开单）
  if (e.openedBy === ENGINE_BOT) ruledOut.push('master_off');
  // 后来有 PR 并做完关单：接活不是一直关着；也不是作者/交代永久挡死；单源不空
  ruledOut.push('dispatch_off', 'untrusted_or_brief', 'empty_source');
  // 断点之后仍被拉起：不是整段窗口熔断停拉
  if (prAt > broken) ruledOut.push('breaker_all_window');

  const intakeMs = e.intakeLimitMinutes * 60_000;
  const waited = broken - opened;
  const lateStart = prAt - opened;
  const nearLimit = waited >= intakeMs - 60_000 && waited <= intakeMs + 60_000;
  const startedAfterBreak = prAt > broken;
  const completed = closed >= prAt;

  if (nearLimit && startedAfterBreak && completed && ruledOut.includes('master_off')) {
    return {
      class: 'intake_slot_delay',
      why: `开单后约 ${Math.round(waited / 60_000)} 分钟判收单超时，约 ${Math.round(lateStart / 60_000)} 分钟后才起任务并做完：空位/准入把巡检挤出收单窗口（非总开关/接活/白名单/整窗熔断）`,
      ruledOut,
    };
  }
  return {
    class: 'unknown',
    why: '旁证不足以归到收单空位延误',
    ruledOut,
  };
}

/** 2026-10-10 第 27 轮（canary #83）的公开旁证。 */
export const ROUND_27_EVIDENCE: CanaryIntakeBreakEvidence = {
  openedAt: '2026-10-10T12:26:02Z',
  // healthz：「10-10 20:46 有结论」→ 北京时间 = UTC+8 → 12:46Z
  brokenAt: '2026-10-10T12:46:00Z',
  firstEnginePrAt: '2026-10-10T12:48:50Z',
  closedCompletedAt: '2026-10-10T12:50:38Z',
  openedBy: ENGINE_BOT,
  intakeLimitMinutes: 20,
};
