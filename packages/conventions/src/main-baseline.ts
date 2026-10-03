// 主线那一轮的基准（#574 之后的 CI 提速，创始人 2026-10-03「主线不跑全量」）：
// 主线不是每次都全跑，而是跑「上一次真绿的头 … 这次的头」这段累计改动，交给现成的 ci-plan 判该跑什么。
// 被后面推送取消掉的轮次不算基准，所以它带进来的改动会被后一轮的区间吃掉，覆盖不会丢。
//
// 改这里之前必须知道：
// - 基准只认「event=push、分支是默认分支、conclusion=success 的 ci.yml 运行」，读不到就是读不到：调用方要退回
//   全跑并明确报警，不许拿空当「上次绿就是 HEAD」——那等于跳过整段改动（底线第三条）。
// - 状态不自己存：GitHub 的运行记录就是唯一事实（和 deploy/france/auto-release/lib.mjs 的 ciVerdict 读同一份）。
//   自己再存一份（库、git 引用、文件）就会漂移。
// - 只往回看这么多轮；一轮都没有（新仓、刚换工作流名）返回 null，由调用方退回全跑。
import type { GhApi } from './gh-api.ts';

/** 往回看多少轮运行找上一次绿的。合并再密也不会连着这么多轮全非绿。 */
export const GREEN_LOOKBACK = 50;

interface RunsBody {
  workflow_runs?: { head_sha?: unknown; head_branch?: unknown; event?: unknown; conclusion?: unknown }[];
}

/**
 * 上一次主线真绿的提交（默认分支上最近一次 conclusion=success 的 ci.yml 运行的头）。
 * 没有（新仓、都在跑、都在红）返回 null；接口读不成抛，由调用方记「没查成」。
 */
export async function lastGreenMainSha(
  api: GhApi,
  workflowFile: string,
  branch: string,
): Promise<string | null> {
  const body = (await api.get(
    `/actions/workflows/${workflowFile}/runs?branch=${encodeURIComponent(branch)}&event=push` +
      `&status=success&per_page=${GREEN_LOOKBACK}`,
  )) as RunsBody;
  const runs = body.workflow_runs ?? [];
  for (const run of runs) {
    if (run.event !== 'push' || run.conclusion !== 'success') continue;
    if (run.head_branch !== branch) continue;
    if (typeof run.head_sha === 'string' && /^[0-9a-f]{40}$/.test(run.head_sha)) return run.head_sha;
  }
  return null;
}
