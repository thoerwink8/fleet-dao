// 看门狗的工作流（#203）：Temporal Schedule 每 5 分钟起一条，只调一个活动跑一轮；看登记表、推撤提醒、结局都由活动做和写库。
// 工作流里不取时刻、不碰库：看哪些任务、几点看，由活动按当时的库定。

import { proxyActivities } from '@temporalio/workflow';
import { activityOptions, type EngineActivities } from '../activity-options.ts';
import type { WatchdogInput, WatchdogRun } from '../contract.ts';
import { DEFAULT_LIMITS } from '../limits.ts';

const { watchSchedules } = proxyActivities<EngineActivities>(
  activityOptions('watchSchedules', DEFAULT_LIMITS),
);

export async function watchdogWorkflow(input: WatchdogInput): Promise<WatchdogRun> {
  return watchSchedules(input ?? { schemaVersion: 1 });
}
