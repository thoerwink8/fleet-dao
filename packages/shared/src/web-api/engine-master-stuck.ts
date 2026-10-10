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
 * 健康检查：总开关关着时，是不是还在发版宽限里（有暂停标记 / 发版车在走 / 刚写过发布历史）。
 * 宽限内报跳过不红；宽限外红（派单链停着），避免 healthz 全绿掩盖。
 */
export function engineMasterOffWithinReleaseGrace(input: {
  pauseActive: boolean;
  trainRunning: boolean;
  lastReleaseAt: Date | null;
  now: Date;
  graceMs?: number;
}): boolean {
  if (input.pauseActive || input.trainRunning) return true;
  const grace = input.graceMs ?? ENGINE_MASTER_RELEASE_GRACE_MS;
  if (!input.lastReleaseAt) return false;
  return input.now.getTime() - input.lastReleaseAt.getTime() < grace;
}
