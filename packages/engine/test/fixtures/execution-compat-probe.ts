// 只用于隔离的真实服务验证：用生产 kit.ts 的 limitsFor 走 taskWorkflow 的首个 local activity，不构造 TaskFlow。
import { limitsFor } from '../../src/workflows/kit.ts';

export async function taskWorkflow(_input: Record<string, unknown>) {
  return await limitsFor(undefined);
}
