// 受管起代（重做）经任务栅栏：在栅栏里重读任务，确认仍是已叫停或挂起，才调 Temporal 另起一代。
// 与受管纠正抢同一把栅栏（store.withTaskFence）：纠正先写完，这里重读到已做完就拒绝；这里先起了代，纠正核对到新代也拒绝。
// 驾驶舱和 task 命令的重做都从这里进，别直接用裸的 taskRedo。
import type { Store } from '@fleet-dao/store';
import type { TaskRedoPort } from './deps.ts';

export function fencedTaskRedo(
  port: TaskRedoPort,
  store: Pick<Store, 'getTask' | 'withTaskFence'>,
): TaskRedoPort {
  return {
    redo(input) {
      return store.withTaskFence(input.taskId, async () => {
        const task = await store.getTask(input.taskId);
        if (!task) return { ok: false as const, why: '库里没有这张任务，不另起' };
        if (task.state !== 'stopped' && task.state !== 'stalled') {
          return { ok: false as const, why: `这张单现在是${task.state}，只有已叫停或挂起的才能重做` };
        }
        return port.redo(input);
      });
    },
  };
}
