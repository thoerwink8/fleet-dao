// 任务工作流的「定模式」（#2826，全程模式第一期）：这张单走三段还是全程，第一次选路之后、第一段动手之前定一次。
//
// 改这里之前必须知道：
// - 结果只来自活动 decideFlowMode（读标签、开关 engine.flowMode、仓档案 flowEligible，写一次 task_flow_assignments 和 tasks.flow_mode），
//   进了历史：重放不再读配置，开关后来改了也不影响在途的单。判法在 flow-mode.ts（chooseFlowMode），分组边界的单测在 test/flow-mode.test.ts。
// - 老历史没有 patched('flow-mode') 的标记：不问、rt.flowMode 保持 null（按三段）。只在这一代的第一段（attemptSeq 是 1）问：
//   在途的单换上新代码时已经过了第一段，不半路改模式。
// - 没定成（活动没装、GitHub 读不到、库不通）：按三段走、进度里写一行，不停下等人。放弃、叫停照常往外抛。
// - 全程只改动手会话的提示词（RunSegmentInput.flowMode）和返工的走法（task.ts）；推分支、开 PR、等 CI、冷验收、合并闸和三段一模一样。

import { isCancellation, log, patched } from '@temporalio/workflow';
import type { RouteChoice } from '../ports.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import type { TierDecision } from '../runner/tier.ts';
import { MAX_FULL_PUSHES } from '../task-contract.ts';
import { failureOf } from './kit.ts';
import type { TaskRuntime } from './task-runtime.ts';
import { Abandoned, MergedTask } from './task-support.ts';

/** 第一段动手之前定一次模式。定过、老历史、不是这一代的第一段：什么都不做。 */
export async function decideFlowOnce(
  rt: TaskRuntime,
  brief: TaskBrief,
  tier: TierDecision,
  route: RouteChoice,
): Promise<void> {
  if (rt.flowMode !== null || rt.attemptSeq !== 1) return;
  if (!patched('flow-mode')) return;
  try {
    const got = await rt.cancellable(() =>
      rt.acts.decideFlowMode({
        schemaVersion: 1,
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        issueNumber: rt.input.issueNumber,
        modelId: route.modelId,
        touches: [...brief.touches],
        stratum: tier.tier,
      }),
    );
    rt.flowMode = got.mode;
    if (got.mode === 'full') {
      await rt.note(
        `这张单走全程（${got.source === 'label' ? '贴了标签' : '按开关分组'}）：CI 红、冲突、冷验收被拒都续同一个会话修，最多交付 ${MAX_FULL_PUSHES} 次`,
      );
    }
  } catch (error) {
    if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
    const why = failureOf(error, 'decideFlowMode').message;
    log.warn('定模式没定成，这张单按三段走', { error: why });
    rt.flowMode = 'three';
    await rt.note(`定模式没定成（${why.slice(0, 200)}），这张单按三段走`);
  }
}
