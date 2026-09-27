// 提醒派单的工作流（design 15.3「谁在处理」）：Temporal Schedule 每 5 分钟起一条，只调一个活动跑一轮；读提醒、再推、开跟进单、
// 结局都由活动做和写库。工作流里不取时刻、不碰库。

import { proxyActivities } from '@temporalio/workflow';
import { activityOptions, type EngineActivities } from '../activity-options.ts';
import type { AlertDispatchInput, AlertDispatchRun } from '../contract.ts';
import { DEFAULT_LIMITS } from '../limits.ts';

const { dispatchAlerts } = proxyActivities<EngineActivities>(
  activityOptions('dispatchAlerts', DEFAULT_LIMITS),
);

export async function alertDispatchWorkflow(input: AlertDispatchInput): Promise<AlertDispatchRun> {
  return dispatchAlerts(input ?? { schemaVersion: 1 });
}
