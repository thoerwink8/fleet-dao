// 发给工作流的信号经 Temporal 客户端发出。这里只依赖客户端的一小块形状（@temporalio/client 的 Client 满足它），
// 装配时传 `new Client(...)` 进来即可；工作流编号怎么拼、信号叫什么由引擎定，引擎按 TaskSignal 的 name 注册同名信号。
// 真客户端等引擎的 PR 合了再接（main.ts 里现在用 notConnectedTemporal，健康检查如实报红）。
import { PublicHealthError } from './health.ts';
import {
  type TaskSignal,
  type TemporalConnection,
  type WorkflowControl,
  WorkflowGoneError,
  WorkflowUnavailableError,
} from './ports.ts';

/** 还没接上 Temporal：发信号一律 503（WorkflowUnavailableError），健康检查报红。不装作接上了。 */
export function notConnectedTemporal(): TemporalConnection {
  const why = 'Temporal 客户端还没接上';
  return {
    control: {
      async signal() {
        throw new WorkflowUnavailableError(why);
      },
    },
    async check() {
      throw new PublicHealthError('not_connected', why);
    },
    async close() {},
  };
}

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
