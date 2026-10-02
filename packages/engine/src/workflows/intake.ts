// 拉单的工作流（#632 S2-4b-3）：Temporal Schedule 每 5 分钟起一条，只调一个活动跑一轮；读哪些仓、哪些单、起哪些任务工作流，
// 都由活动按当时的库和 GitHub 定并写库。工作流里不取时刻、不碰库、不起别的工作流（起任务工作流要用活动自己的 Temporal 客户端）。

import { proxyActivities } from '@temporalio/workflow';
import { activityOptions, type EngineActivities } from '../activity-options.ts';
import type { IntakeInput, IntakeRun } from '../contract.ts';
import { DEFAULT_LIMITS } from '../limits.ts';

const { intakeRound } = proxyActivities<EngineActivities>(activityOptions('intakeRound', DEFAULT_LIMITS));

export async function intakeWorkflow(input: IntakeInput): Promise<IntakeRun> {
  return intakeRound(input ?? { schemaVersion: 1 });
}
