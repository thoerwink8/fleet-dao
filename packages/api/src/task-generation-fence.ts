// 受管起代（重做）先落起代意图：任务行锁里重读，仍是已叫停或挂起才落意图、改更新时间，提交后才调 Temporal 另起一代。
// 和受管纠正抢的是同一行：纠正先写完，这里重读到已做完就拒绝；这里先落了意图，纠正的事务看到没结的意图或更新时间变了也拒绝。
// 真要起某一代之前在行锁里绑下目标代数（beforeStart）；被后来的重做接手的旧持有者绑不了，不会越代再起。
// 结算判法在 shared 的 fenceRedo（指挥官的重做也用它）：列代明确看到的代数、绑了目标且起的那一步正常回来，才算明确；
// 起之后抛错、超时、进程退出都不结，意图挂着，纠正一直拒绝，不靠超时放行；再跑一次重做核清。
// 驾驶舱和 task 命令的重做都从这里进，别直接用裸的 taskRedo。TaskRedoPort 必须在任何 start 之前调 beforeStart。
import type { TaskStartActor } from '@fleet-dao/db';
import { fenceRedo } from '@fleet-dao/shared/task-redo';
import type { Store } from '@fleet-dao/store';
import type { TaskRedoPort } from './deps.ts';

export function fencedTaskRedo(
  port: TaskRedoPort,
  store: Pick<Store, 'beginTaskStart' | 'bindTaskStart' | 'settleTaskStart'>,
  actor: TaskStartActor,
): TaskRedoPort {
  return {
    redo(input) {
      const { taskId } = input;
      return fenceRedo(
        {
          async begin() {
            const begun = await store.beginTaskStart({ taskId, allowed: ['stopped', 'stalled'], actor });
            if (begun.ok) return begun;
            return {
              ok: false,
              why:
                begun.reason ??
                (begun.state === null
                  ? '库里没有这张任务，不另起'
                  : `这张单现在是${begun.state}，只有已叫停或挂起的才能重做`),
            };
          },
          bind: (intent, workflowId, generation) =>
            store.bindTaskStart({ taskId, intent, workflowId, generation, actor }),
          settle: (intent, claimed, outcome) =>
            store.settleTaskStart({ taskId, intent, claimed, outcome, actor }),
        },
        (hooks) => port.redo({ ...input, beforeStart: hooks.beforeStart, observed: hooks.observed }),
      );
    },
  };
}
