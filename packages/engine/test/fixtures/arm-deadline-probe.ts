// 只给测试：用生产的 activityOptionsWithin 把 armAutoMerge 的 scheduleToClose 收成 1 秒。
// 不进引擎的工作流包。证明无心跳活动在服务端判超时之后继续跑时，不会再发起挂合并写。
import { proxyActivities } from '@temporalio/workflow';
import { activityOptionsWithin, type EngineActivities } from '../../src/activity-options.ts';
import { DEFAULT_LIMITS } from '../../src/limits.ts';
import type { ArmAutoMergeInput } from '../../src/task-contract.ts';
import { failureOf } from '../../src/workflows/kit.ts';

export async function armDeadlineProbe(input: ArmAutoMergeInput): Promise<string> {
  const { armAutoMerge } = proxyActivities<EngineActivities>(
    activityOptionsWithin('armAutoMerge', DEFAULT_LIMITS, 1),
  );
  try {
    await armAutoMerge(input);
    return 'completed';
  } catch (error) {
    return failureOf(error, 'armAutoMerge', DEFAULT_LIMITS).code;
  }
}
