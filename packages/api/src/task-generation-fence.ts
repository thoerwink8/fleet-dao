// 受管起代（重做）先落起代意图：任务行锁里重读，仍是已叫停或挂起才落意图、改更新时间，提交后才调 Temporal 另起一代。
// 和受管纠正抢的是同一行：纠正先写完，这里重读到已做完就拒绝；这里先落了意图，纠正的事务看到没结的意图或更新时间变了也拒绝。
// 起代结果明确（起成或确定没起）才落已结；抛错、超时、进程退出都不落，意图一直挂着，纠正一直拒绝，不靠超时放行。
// 驾驶舱和 task 命令的重做都从这里进，别直接用裸的 taskRedo。
import type { TaskStartActor } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { Store } from '@fleet-dao/store';
import type { TaskRedoPort } from './deps.ts';

export function fencedTaskRedo(
  port: TaskRedoPort,
  store: Pick<Store, 'beginTaskStart' | 'settleTaskStart'>,
  actor: TaskStartActor,
): TaskRedoPort {
  return {
    async redo(input) {
      const begun = await store.beginTaskStart({
        taskId: input.taskId,
        allowed: ['stopped', 'stalled'],
        actor,
      });
      if (!begun.ok) {
        return {
          ok: false as const,
          why:
            begun.reason ??
            (begun.state === null
              ? '库里没有这张任务，不另起'
              : `这张单现在是${begun.state}，只有已叫停或挂起的才能重做`),
        };
      }
      const outcome = await port.redo(input);
      const settled = outcome.ok ? `started ${outcome.workflowId}` : `not_started ${outcome.why}`;
      try {
        await store.settleTaskStart({ taskId: input.taskId, intent: begun.intent, outcome: settled, actor });
      } catch (err) {
        // 已结没写进：意图照样挂着（纠正继续拒绝，保守），起代结果本身如实交回去
        if (outcome.ok) return outcome;
        return { ok: false as const, why: `${outcome.why}；起代已结也没记上（${errMessage(err)}）` };
      }
      return outcome;
    },
  };
}
