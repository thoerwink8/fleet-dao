// 引擎总开关被发版暂停后没开回（#1674 / #1732）：健康检查和看门狗自动开回共用这一份判法。
// 有意关（驾驶舱点的、人手 fleet-api engine off 且原因不含「发版前暂停」）不自动开、健康项照红，避免监督被 healthz 全绿掩盖。

import { ENGINE_MASTER_DISABLE, ENGINE_MASTER_ENABLE } from './engine-switch.ts';

/** 发版停派到恢复的宽限：等收尾 + 发版 + 部署 + 验证，比各步上限加起来略宽。过了还关着才当卡住。 */
export const ENGINE_MASTER_RELEASE_GRACE_MS = 45 * 60_000;

/** 操作记录里发版车 / 驾驶舱发布把总开关关上时，原因里会带的字（release-train、release-request 两处都写「发版前暂停」）。 */
export const ENGINE_MASTER_RELEASE_PAUSE_HINT = '发版前暂停';

export type EngineMasterAuditRow = {
  action: string;
  reason: string | null;
  at: Date;
};

/**
 * 最近一笔总开关操作是不是「发版暂停关上、之后没有开回」。
 * 有意关、从没设过、最近一笔是打开：都不是卡住。
 */
export function isReleaseStuckMasterOff(input: {
  masterOn: boolean;
  /** 最近一笔 engine.master.enable / disable（按时间倒序的第一条）；没有是 null。 */
  latest: EngineMasterAuditRow | null;
  now: Date;
  /** 发版暂停标记还在，或发版车状态是 running：还在发版流程里，不算卡住。 */
  releaseInFlight: boolean;
  graceMs?: number;
}): boolean {
  if (input.masterOn) return false;
  if (input.releaseInFlight) return false;
  const latest = input.latest;
  if (!latest) return false;
  if (latest.action === ENGINE_MASTER_ENABLE) return false;
  if (latest.action !== ENGINE_MASTER_DISABLE) return false;
  const reason = latest.reason ?? '';
  if (!reason.includes(ENGINE_MASTER_RELEASE_PAUSE_HINT)) return false;
  const grace = input.graceMs ?? ENGINE_MASTER_RELEASE_GRACE_MS;
  return input.now.getTime() - latest.at.getTime() >= grace;
}

/**
 * 发版现场（暂停标记 / status=running）是不是还在宽限里。
 * 驱动死了、标记或 running 留下超过宽限 → 不算在走（#1732 返工：不然 franceReleaseInFlight 永远 true，自动开回跳过、健康检查一直绿）。
 * 时刻认不出：按「不在走」算（宁可不漏报、不挡恢复）。
 */
export function releaseSiteInFlight(input: {
  /** 有暂停标记。 */
  pauseActive: boolean;
  /** 暂停标记的 mtime（epoch ms）；没有或不认是 null。 */
  pauseMtimeMs: number | null;
  /** 发版车 progress 的 status 是不是 running。 */
  trainRunning: boolean;
  /** running 进度的心跳/更新时刻；没有或不认是 null。 */
  trainBeatMs: number | null;
  now: Date;
  graceMs?: number;
}): boolean {
  const grace = input.graceMs ?? ENGINE_MASTER_RELEASE_GRACE_MS;
  const nowMs = input.now.getTime();
  const fresh = (atMs: number | null): boolean =>
    atMs !== null && Number.isFinite(atMs) && nowMs - atMs < grace;
  if (input.pauseActive && fresh(input.pauseMtimeMs)) return true;
  if (input.trainRunning && fresh(input.trainBeatMs)) return true;
  return false;
}

/**
 * 健康检查：总开关关着时，是不是还在发版宽限里（新鲜的暂停标记 / 发版车在走 / 刚写过发布历史）。
 * 宽限内报跳过不红；宽限外红（派单链停着），避免 healthz 全绿掩盖。
 */
export function engineMasterOffWithinReleaseGrace(input: {
  pauseActive: boolean;
  pauseMtimeMs: number | null;
  trainRunning: boolean;
  trainBeatMs: number | null;
  lastReleaseAt: Date | null;
  now: Date;
  graceMs?: number;
}): boolean {
  if (
    releaseSiteInFlight({
      pauseActive: input.pauseActive,
      pauseMtimeMs: input.pauseMtimeMs,
      trainRunning: input.trainRunning,
      trainBeatMs: input.trainBeatMs,
      now: input.now,
      ...(input.graceMs !== undefined ? { graceMs: input.graceMs } : {}),
    })
  ) {
    return true;
  }
  const grace = input.graceMs ?? ENGINE_MASTER_RELEASE_GRACE_MS;
  if (!input.lastReleaseAt) return false;
  return input.now.getTime() - input.lastReleaseAt.getTime() < grace;
}

/**
 * 关着时最近一笔是不是「发版前暂停」且还没开回（不管过没过宽限）。
 * 驾驶舱发布：总开关已关、现场没暂停标记时，用它判断该不该按发版前开着记（#1732：发版车死了没清标记的那类）。
 */
export function latestAuditIsReleasePause(latest: EngineMasterAuditRow | null): boolean {
  if (!latest) return false;
  if (latest.action !== ENGINE_MASTER_DISABLE) return false;
  return (latest.reason ?? '').includes(ENGINE_MASTER_RELEASE_PAUSE_HINT);
}
