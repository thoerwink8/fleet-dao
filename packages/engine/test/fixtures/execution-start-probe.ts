// 只给读取器的真实服务测试使用，不加入生产工作流包，也不准入执行资格。
import { proxyLocalActivities } from '@temporalio/workflow';
import type { ExecutionStartRead } from '../../src/real/execution-start-reader.ts';

export async function executionStartProbe(_input: Record<string, unknown>): Promise<ExecutionStartRead> {
  const { observeStart } = proxyLocalActivities<{ observeStart(): Promise<ExecutionStartRead> }>({
    startToCloseTimeout: '15s',
    retry: { maximumAttempts: 1 },
  });
  return observeStart();
}
