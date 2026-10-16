// 等合并时读这个头上的必过检查，外加仓档案 mergeSignals 里点名的检查（fleet-dao 是 merge-gate 和 cold-verify）。
// 和等 CI 分开：等 CI 会把合并闸排除掉（还没验收）；等合并时档案里的检查红了就是红了，要交回返工。
// 档案没写 merge-gate 的仓不等它：别的仓没有这条状态，写死了会永远等不到。
// 主线规则一条必过都没有时，不把 NO_REQUIRED_CHECKS 当成「还在等」抛出去挡死：仍看档案里的检查。别的读失败原样抛。

import { COLD_VERIFY_CONTEXT, GATE_CONTEXT } from '@fleet-dao/conventions';
import { type GitHub, isGitHubError, type RepoRef, readCi, requiredChecksFor } from '@fleet-dao/github';

export interface MergeWaitCheckRead {
  overall: 'green' | 'red' | 'pending' | 'none';
  failed: { name: string; detail?: string }[];
}

function gateWaitingForColdVerify(
  checks: readonly { name: string; state: string; detail?: string | undefined }[],
): boolean {
  const cold = checks.find((item) => item.name === COLD_VERIFY_CONTEXT);
  const gate = checks.find((item) => item.name === GATE_CONTEXT);
  return (
    cold?.state === 'pending' && gate?.state === 'failure' && gate.detail?.startsWith('等验收：') === true
  );
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
    if (actualFailures.length === 0) return { overall: 'pending', failed: [] };
    return { overall: 'red', failed: actualFailures };
  }
  if (failed.length > 0) return { overall: 'red', failed };
  if (evaluation.overall === 'green') return { overall: 'green', failed: [] };
  if (evaluation.overall === 'none') return { overall: 'none', failed: [] };
  return { overall: 'pending', failed: [] };
}
