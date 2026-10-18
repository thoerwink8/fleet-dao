// 等合并时读这个头上的必过检查，外加仓档案 mergeSignals 里点名的检查（fleet-dao 是 merge-gate 和 cold-verify）。
// 和等 CI 分开：等 CI 会把合并闸排除掉（还没验收）；等合并时档案里的检查红了就是红了，要交回返工。
// 档案没写 merge-gate 的仓不等它：别的仓没有这条状态，写死了会永远等不到。
// 主线规则一条必过都没有时，不把 NO_REQUIRED_CHECKS 当成「还在等」抛出去挡死：仍看档案里的检查。别的读失败原样抛。

import { COLD_VERIFY_CONTEXT, GATE_CONTEXT } from '@fleet-dao/conventions';
import { type GitHub, isGitHubError, type RepoRef, readCi, requiredChecksFor } from '@fleet-dao/github';

export interface MergeWaitCheckRead {
  overall: 'green' | 'red' | 'pending' | 'none';
  failed: { name: string; detail?: string }[];
  /**
   * 还在跑（queued / in_progress）的检查名。没出现的不放进来。没有就不带这个字段。
   */
  pending?: { name: string }[];
  /**
   * readCi 记成 pending、却不是在跑的（跑完了结论是 stale 或认不出、waiting / requested 这些）：检查名和 GitHub 原样的词。
   * 有这一项就不带 pending，挂合并不据此有界等待，显式报没查成。没有就不带这个字段。
   */
  unsettled?: { name: string; conclusion: string }[];
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

function pendingRead(failed: MergeWaitCheckRead['failed'], checks: readonly Verdict[]): MergeWaitCheckRead {
  const { running, unsettled } = splitPending(checks);
  if (unsettled.length > 0) return { overall: 'pending', failed, unsettled };
  return running.length > 0
    ? { overall: 'pending', failed, pending: running }
    : { overall: 'pending', failed };
}

function gateWaitingForColdVerify(
  checks: readonly { name: string; state: string; detail?: string | undefined }[],
): boolean {
  const gate = checks.find((item) => item.name === GATE_CONTEXT);
  if (gate?.state !== 'failure' || gate.detail?.startsWith('等验收：') !== true) return false;
  const cold = checks.find((item) => item.name === COLD_VERIFY_CONTEXT);
  // 闸的原文已经写明冷验收还在跑。cold-verify 没列进档案、这次没读到，或还是 pending，都不算红。
  // 它已经出了别的结论（过了或没过）时不在这里挡：闸下次重算会改掉「等验收」。
  return cold === undefined || cold.state === 'pending' || cold.state === 'missing';
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
  const failed = evaluation.checks
    .filter((item) => item.state === 'failure')
    .map((item) => ({ name: item.name, ...(item.detail ? { detail: item.detail } : {}) }));
  if (gateWaitingForColdVerify(evaluation.checks)) {
    const actualFailures = failed.filter((item) => item.name !== GATE_CONTEXT);
    if (actualFailures.length === 0) return pendingRead([], evaluation.checks);
    return { overall: 'red', failed: actualFailures };
  }
  if (failed.length > 0) return { overall: 'red', failed };
  if (evaluation.overall === 'green') return { overall: 'green', failed: [] };
  if (evaluation.overall === 'none') return { overall: 'none', failed: [] };
  return pendingRead([], evaluation.checks);
}
