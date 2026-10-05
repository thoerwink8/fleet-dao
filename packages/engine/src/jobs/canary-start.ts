// 起一轮全流程巡检的工作流（#1072：不再由 Temporal Schedule 起，改由引擎的进程内定时器 jobs/engine-timers.ts 起，pnpm drill 也走这里）。
// 巡检一轮要一路看五个小时、中间引擎重启要接着看，所以这一条留在 Temporal 里当一条长工作流；摘掉的只是「定时起它」那一层。
// 编号固定（CANARY_WORKFLOW_ID）：同一时刻最多一轮在跑——已经有一轮在跑，起第二条会被 Temporal 拒掉，调用方照这个结果跳过（定时器）
// 或接上它（演练）；两轮叠着跑会在巡检仓里抢同一个文件。
import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  type WorkflowHandle,
  type WorkflowHandleWithFirstExecutionRunId,
} from '@temporalio/client';
import { type CanaryInput, WORKFLOW_TYPES } from '../contract.ts';
import { CANARY_JOB, CANARY_RUN_TIMEOUT_MINUTES } from './canary.ts';

export const CANARY_WORKFLOW_ID = CANARY_JOB.id;

export type CanaryStart =
  | { started: true; handle: WorkflowHandleWithFirstExecutionRunId }
  /** 已经有一轮在跑：没另起。 */
  | { started: false; handle: WorkflowHandle };

export async function startCanaryWorkflow(
  client: Pick<Client, 'workflow'>,
  taskQueue: string,
): Promise<CanaryStart> {
  const input: CanaryInput = { schemaVersion: 1 };
  try {
    const handle = await client.workflow.start(WORKFLOW_TYPES.canary, {
      taskQueue,
      workflowId: CANARY_WORKFLOW_ID,
      args: [input],
      // 一轮自己到 5 小时就判断在当时那一步；再多给半小时（开单、没查成的几回），卡死的不拖到下一轮
      workflowRunTimeout: `${CANARY_RUN_TIMEOUT_MINUTES} minutes`,
      workflowIdConflictPolicy: 'FAIL',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    return { started: true, handle };
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    return { started: false, handle: client.workflow.getHandle(CANARY_WORKFLOW_ID) };
  }
}
