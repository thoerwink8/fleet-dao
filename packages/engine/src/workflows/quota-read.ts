// 定时读额度入库的工作流（#76）：Temporal Schedule 每 15 分钟起一条，只调一个活动跑一轮；读到的、结局、报警都由活动写库。
// 工作流里不取时刻、不碰库和上游：读哪些池、几点读，由活动按当时的配置和时刻定。

import { proxyActivities } from '@temporalio/workflow';
import { activityOptions, type EngineActivities } from '../activity-options.ts';
import type { QuotaReadInput, QuotaReadRun } from '../contract.ts';
import { DEFAULT_LIMITS } from '../limits.ts';

const { readQuotas } = proxyActivities<EngineActivities>(activityOptions('readQuotas', DEFAULT_LIMITS));

export async function quotaReadWorkflow(input: QuotaReadInput): Promise<QuotaReadRun> {
  return readQuotas(input ?? { schemaVersion: 1 });
}
