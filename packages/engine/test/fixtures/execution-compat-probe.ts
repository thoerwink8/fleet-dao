// 只用于隔离的真实服务验证：用生产 kit.ts 的 limitsFor 走 taskWorkflow 的首个 local activity，不构造 TaskFlow。
// hold=true 时停在信号上（混部/回退验证要一个在途 run）；continueProbe 用来产生 ContinuedAsNew 终态。
import { condition, continueAsNew, defineSignal, setHandler } from '@temporalio/workflow';
import { limitsFor } from '../../src/workflows/kit.ts';

export const finishSignal = defineSignal('finish');

export async function taskWorkflow(input: Record<string, unknown>) {
  const limits = await limitsFor(undefined);
  if (input.hold === true) {
    let done = false;
    setHandler(finishSignal, () => {
      done = true;
    });
    await condition(() => done);
  }
  return limits;
}

export async function continueProbe(round = 0): Promise<number> {
  if (round === 0) return await continueAsNew<typeof continueProbe>(1);
  return round;
}
