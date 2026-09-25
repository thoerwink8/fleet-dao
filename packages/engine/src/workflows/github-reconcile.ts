// 定时对账补漏的工作流（#43）：Temporal Schedule 每 15 分钟起一条，只调一个活动跑一轮；结局由活动记进 schedule_runs。
// 工作流里不取时刻、不碰库和 GitHub：往回看到哪一刻由活动按当时的时刻算。

import { proxyActivities } from '@temporalio/workflow';
import { activityOptions, type EngineActivities } from '../activity-options.ts';
import type { GitHubReconcileInput, GitHubReconcileRun } from '../contract.ts';
import { DEFAULT_LIMITS } from '../limits.ts';

const { reconcileGitHub } = proxyActivities<EngineActivities>(
  activityOptions('reconcileGitHub', DEFAULT_LIMITS),
);

export async function githubReconcileWorkflow(input: GitHubReconcileInput): Promise<GitHubReconcileRun> {
  return reconcileGitHub(input ?? { schemaVersion: 1 });
}
