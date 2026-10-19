// 等合并时读这个头上的必过检查，外加仓档案 mergeSignals 里点名的检查（fleet-dao 是 merge-gate 和 cold-verify）。
// 和等 CI 分开：等 CI 会把合并闸排除掉（还没验收）；等合并时档案里的检查红了就是红了，要交回返工。
// 档案没写 merge-gate 的仓不等它：别的仓没有这条状态，写死了会永远等不到。
// 主线规则一条必过都没有时，不把 NO_REQUIRED_CHECKS 当成「还在等」抛出去挡死：仍看档案里的检查。别的读失败原样抛。

import { GATE_CONTEXT } from '@fleet-dao/conventions';
import { type GitHub, isGitHubError, type RepoRef, readCi, requiredChecksFor } from '@fleet-dao/github';

export interface MergeWaitCheckRead {
  overall: 'green' | 'red' | 'pending' | 'none';
  failed: { name: string; detail?: string }[];
  /**
   * 还在跑（queued / in_progress）的检查名。没出现的不放进来。
   * 必过名单里只要有一条没出现，整份都不带这个字段：不能靠旁边一条还在跑的装成可等。没有就不带。
   */
  pending?: { name: string }[];
  /**
   * readCi 记成 pending、却不是在跑的（跑完了结论是 stale 或认不出、waiting / requested 这些）：检查名和 GitHub 原样的词。
   * 有这一项就不带 pending，挂合并不据此有界等待，显式报没查成。没有就不带这个字段。
   */
  unsettled?: { name: string; conclusion: string }[];
  /**
   * 必过名单里这次没出现的（readCi 的 missing）。有就不带 pending：没出现不是还在跑。
   * 挂合并点名这些检查、写没查成，不进入有界等待。没有就不带这个字段。
   */
  missing?: { name: string }[];
}

type Verdict = { name: string; state: string; conclusion?: string | undefined };

/**
 * 算「还在跑」的 GitHub 原词：检查的 status 是 queued / in_progress；提交状态（merge-gate、cold-verify 是这种）只有 pending
 * 一个没出结论的词，跑完了只会是 success / failure / error。检查跑完的结论里没有这三个词。
 */
const RUNNING = new Set(['queued', 'in_progress', 'pending']);

/** readCi 的 pending 分成真在跑的和别的（stale、认不出……）。没出现、红了的都不算。 */
function splitPending(checks: readonly Verdict[]): {
  running: { name: string }[];
  unsettled: { name: string; conclusion: string }[];
} {
  const running: { name: string }[] = [];
  const unsettled: { name: string; conclusion: string }[] = [];
  for (const item of checks) {
    if (item.state !== 'pending') continue;
    const name = item.name.trim();
    const conclusion = item.conclusion ?? '';
    if (name.length > 0 && RUNNING.has(conclusion)) {
      if (!running.some((r) => r.name === name)) running.push({ name });
      continue;
    }
    unsettled.push({ name: name.length > 0 ? name : '（没写是哪项）', conclusion: conclusion || 'unknown' });
  }
  return { running, unsettled };
}

/** 必过名单里 state 是 missing 的。空名字跳过（名单本身都有名字）。 */
function missingNames(checks: readonly Verdict[]): { name: string }[] {
  const names: { name: string }[] = [];
  for (const item of checks) {
    if (item.state !== 'missing') continue;
    const name = item.name.trim();
    if (name.length === 0 || names.some((entry) => entry.name === name)) continue;
    names.push({ name });
  }
  return names;
}

/** 合并闸只因冷验收还在跑而失败时，description 的开头（merge-gates.ts 的 checkColdVerify）。 */
const AWAITING_VERIFY = '等验收：';
/** description 里还有别的不通过理由时，不能把整条当成「只是在等验收」。 */
const EXTRA_REASONS = '（另有 ';

/**
 * 闸的失败原文是不是「只在等验收」。冷验收已经贴了通过、闸还没重算时，原文仍是这句；
 * 带「另有」的是同一条里还有别的不通过，照旧当红。
 */
function gateOnlyAwaitingVerify(detail: string | undefined): boolean {
  return detail?.startsWith(AWAITING_VERIFY) === true && !detail.includes(EXTRA_REASONS);
}

/**
 * 把「只在等验收」的合并闸从失败改成还在跑。冷验收是 pending、missing，或已经 success，都不交回返工：
 * 验收跑完闸会重算。验收自己已经失败时，红名单里只留验收，不把这句过时的「等验收」再算一条红。
 */
function awaitingVerifyAsPending<T extends Verdict & { detail?: string | undefined }>(
  checks: readonly T[],
): T[] {
  return checks.map((item) => {
    if (item.name !== GATE_CONTEXT || item.state !== 'failure' || !gateOnlyAwaitingVerify(item.detail))
      return item;
    return { ...item, state: 'pending', conclusion: 'pending' };
  });
}

/**
 * 还在跑、没出结论、没出现分开交。有没出现或没出结论的，就不带 pending：
 * 旁边一条 in_progress 不能把「没出现」装成还能等。
 */
function pendingRead(failed: MergeWaitCheckRead['failed'], checks: readonly Verdict[]): MergeWaitCheckRead {
  const { running, unsettled } = splitPending(checks);
  const missing = missingNames(checks);
  if (missing.length > 0 || unsettled.length > 0) {
    return {
      overall: 'pending',
      failed,
      ...(unsettled.length > 0 ? { unsettled } : {}),
      ...(missing.length > 0 ? { missing } : {}),
    };
  }
  return running.length > 0
    ? { overall: 'pending', failed, pending: running }
    : { overall: 'pending', failed };
}

export async function readMergeWaitChecks(
  gh: Pick<GitHub, 'deps'>,
  repo: RepoRef,
  sha: string,
  mergeSignals: readonly string[],
  signal?: AbortSignal,
): Promise<MergeWaitCheckRead> {
  let required: string[] = [];
  try {
    required = await requiredChecksFor(gh.deps, repo, undefined, signal);
  } catch (error) {
    if (!isGitHubError(error, 'NO_REQUIRED_CHECKS')) throw error;
  }
  const names = [...new Set([...required, ...mergeSignals])];
  if (names.length === 0) return { overall: 'none', failed: [] };
  const { evaluation } = await readCi(gh.deps, repo, sha, names, signal);
  // 先把「只在等验收」的闸改成还在跑，再判红。否则冷验收已经 success、闸的旧 failure 还写着「等验收」时，
  // 会在闸重算之前被当成真红交回返工（#3316 头 10eb6fb）。
  const checks = awaitingVerifyAsPending(evaluation.checks);
  const failed = checks
    .filter((item) => item.state === 'failure')
    .map((item) => ({ name: item.name, ...(item.detail ? { detail: item.detail } : {}) }));
  if (failed.length > 0) return { overall: 'red', failed };
  if (checks.length > 0 && checks.every((item) => item.state === 'success'))
    return { overall: 'green', failed: [] };
  if (checks.every((item) => item.state === 'missing')) {
    const missing = missingNames(checks);
    return missing.length > 0 ? { overall: 'none', failed: [], missing } : { overall: 'none', failed: [] };
  }
  return pendingRead([], checks);
}
