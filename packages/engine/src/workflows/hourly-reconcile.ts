// 每小时对账的工作流：Temporal Schedule 每小时起一条，只调一个活动跑一轮；删树、撤提醒、再推、结局都由活动做和写库。
// 工作流里不取时刻、不碰库和目录：看哪些树、哪些提醒，由活动按当时的目录和库定。

import { proxyActivities } from '@temporalio/workflow';
import { activityOptions, type EngineActivities } from '../activity-options.ts';
import type { HourlyReconcileInput, HourlyReconcileRun } from '../contract.ts';
import { DEFAULT_LIMITS } from '../limits.ts';

const { reconcileHourly } = proxyActivities<EngineActivities>(
  activityOptions('reconcileHourly', DEFAULT_LIMITS),
);

export async function hourlyReconcileWorkflow(input: HourlyReconcileInput): Promise<HourlyReconcileRun> {
  return reconcileHourly(input ?? { schemaVersion: 1 });
}
