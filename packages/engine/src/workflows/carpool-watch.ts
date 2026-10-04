// 拼车额度盯读的工作流（#194）：Temporal Schedule 每分钟起一条，只调一个活动跑一轮；读不读接口、判不判切号都由活动按账本和当时的
// 时刻定。工作流里不取时刻、不碰库和上游。

import { proxyActivities } from '@temporalio/workflow';
import { activityOptions, type EngineActivities } from '../activity-options.ts';
import type { CarpoolWatchInput, CarpoolWatchRun } from '../contract.ts';
import { DEFAULT_LIMITS } from '../limits.ts';

const { watchCarpool } = proxyActivities<EngineActivities>(activityOptions('watchCarpool', DEFAULT_LIMITS));

export async function carpoolWatchWorkflow(input: CarpoolWatchInput): Promise<CarpoolWatchRun> {
  return watchCarpool(input ?? { schemaVersion: 1 });
}
