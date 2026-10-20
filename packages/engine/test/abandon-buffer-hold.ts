// 只给 #3413 的回归打包进工作流：放弃信号的任务在发出命令之前登记一次挂起。
// 挂起发生在激活返回之后、完成 RPC 之前，测试趁任务仍 STARTED 把 runSegment 完成送进服务端。
import { TASK_SIGNAL_NAMES } from '@fleet-dao/shared/task-signals';
import { proxySinks, type Sinks, type WorkflowInterceptors } from '@temporalio/workflow';

export interface AbandonHoldSinks extends Sinks {
  hold: {
    abandon(): void;
  };
}

const { hold } = proxySinks<AbandonHoldSinks>();

export function interceptors(): WorkflowInterceptors {
  return {
    inbound: [
      {
        async handleSignal(input, next) {
          if (input.signalName === TASK_SIGNAL_NAMES.abandon) hold.abandon();
          return next(input);
        },
      },
    ],
  };
}
