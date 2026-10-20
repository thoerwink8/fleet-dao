// 只用于隔离的真实服务验证，不加入生产工作流入口；typed 拒绝不转换 Workflow 失败。
import { proxyLocalActivities } from '@temporalio/workflow';
import type { LegacySourceAdmission } from '../../src/real/execution-legacy-admission.ts';

export async function taskWorkflow(_input: Record<string, unknown>): Promise<LegacySourceAdmission[]> {
  const { decide } = proxyLocalActivities<{ decide(): Promise<LegacySourceAdmission> }>({
    startToCloseTimeout: '15s',
    retry: { maximumAttempts: 1 },
  });
  return [await decide(), await decide()];
}
