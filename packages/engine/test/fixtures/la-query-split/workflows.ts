// #3413：本地活动之后紧接 patched() 的最小工作流（la-query-split.test.ts 用）。
// 真工作流 task.ts 开头就是这样：limitsFor（本地活动 decide）回来，activitiesFor 立刻问 patched('self-check-own-timeout')。
import { patched, proxyActivities, proxyLocalActivities } from '@temporalio/workflow';

const { gate } = proxyLocalActivities<{ gate(): Promise<void> }>({ startToCloseTimeout: '30 seconds' });
const { after } = proxyActivities<{ after(): Promise<void> }>({ startToCloseTimeout: '30 seconds' });

/** 本地活动回来之后才问补丁：和 task.ts 开头同形。 */
export async function patchAfterLocal(): Promise<boolean> {
  await gate();
  const seen = patched('probe');
  await after();
  return seen;
}

/** 对照：本地活动之后不问补丁，只调普通活动。 */
export async function plainAfterLocal(): Promise<void> {
  await gate();
  await after();
}

/** 对照：补丁在本地活动之前问。 */
export async function patchBeforeLocal(): Promise<boolean> {
  const seen = patched('probe');
  await gate();
  await after();
  return seen;
}
