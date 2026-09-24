// 发给工作流的信号经 Temporal 客户端发出。这里只依赖客户端的一小块形状（@temporalio/client 的 Client 满足它），
// 装配时传 `new Client(...)` 进来即可；工作流编号怎么拼、信号叫什么由引擎定，引擎按 TaskSignal 的 name 注册同名信号。
import { type TaskSignal, type WorkflowControl, WorkflowGoneError } from './ports.ts';

export interface TemporalClientLike {
  workflow: {
    getHandle(workflowId: string): { signal(name: string, arg: unknown): Promise<void> };
  };
}

export function createTemporalWorkflowControl(
  client: TemporalClientLike,
  options: { workflowIdForTask: (taskId: string) => string },
): WorkflowControl {
  return {
    async signal(taskId: string, signal: TaskSignal) {
      const { name, ...arg } = signal;
      try {
        await client.workflow.getHandle(options.workflowIdForTask(taskId)).signal(name, arg);
      } catch (err) {
        if (isGone(err)) throw new WorkflowGoneError(taskId, err);
        throw err;
      }
    },
  };
}

/** 工作流不存在或已经结束：Temporal 客户端抛 WorkflowNotFoundError（服务端 NOT_FOUND）。 */
function isGone(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'WorkflowNotFoundError' || /workflow execution already completed/i.test(err.message))
  );
}
