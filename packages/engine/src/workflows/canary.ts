// 全流程巡检的工作流（#223）：Temporal Schedule 每 6 小时起一条。开单、看一回、判、记结论、推报警都在活动里
// （jobs/canary.ts），工作流只管开单之后隔一会儿看一回、一直看到有结论。
// 看一回的活动本身失败（工人丢了、记结论没成）：隔一回再看，连着失败到上限就让这一轮失败——库里停在「在跑」，
// 登记表上过期，看门狗照样看得见。工作流里不取时刻、不碰库和 GitHub。

import { ActivityFailure, proxyActivities, sleep } from '@temporalio/workflow';
import { activityOptions, type EngineActivities } from '../activity-options.ts';
import { CANARY_CHECK_FAILURE_LIMIT, CANARY_POLL_SECONDS, type CanaryInput } from '../contract.ts';
import type { CanaryRun, CanaryStepResult } from '../jobs/canary.ts';
import { DEFAULT_LIMITS } from '../limits.ts';

const { canaryOpen } = proxyActivities<EngineActivities>(activityOptions('canaryOpen', DEFAULT_LIMITS));
const { canaryCheck } = proxyActivities<EngineActivities>(activityOptions('canaryCheck', DEFAULT_LIMITS));

export async function canaryWorkflow(input: CanaryInput): Promise<CanaryRun> {
  let step: CanaryStepResult = await canaryOpen(input ?? { schemaVersion: 1 });
  let failures = 0;
  while (!step.done) {
    await sleep(`${CANARY_POLL_SECONDS} seconds`);
    try {
      step = await canaryCheck({ schemaVersion: 1, state: step.state });
      failures = 0;
    } catch (error) {
      if (!(error instanceof ActivityFailure)) throw error;
      failures += 1;
      if (failures >= CANARY_CHECK_FAILURE_LIMIT) throw error;
    }
  }
  return step.run;
}
