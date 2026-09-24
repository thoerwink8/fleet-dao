// 问 Jev 的那一步：本目录里唯一要等网络的地方，只在活动里调（工作流里调会把不确定的东西带进历史）。
// 先纯函数判一次，认不出、拿不准才问；问完带着回答再用同一个纯函数判一次。默认不问。

import { classifyFailure } from './classify.ts';
import type { JevPort, JevQuestion, JevReply } from './jev.ts';
import { judgeStall, type StallFacts, type StallPolicy, type StallVerdict } from './stall.ts';
import type { FailureEvidence, FailurePolicy, FailureVerdict } from './types.ts';

/** 默认实现：不问。Jev 那个包接好之前、或驾驶舱里关掉这两道题时用它。 */
export const NO_JEV: JevPort = {
  ask: async () => ({ asked: false, reason: '没接 Jev，默认不问' }),
};

/** 问一次。抛错、超时（预算 2 秒，盲设计题三臂的建议值）都当「没判出来」，不当成「否」。 */
export async function askJev<C extends string>(
  port: JevPort,
  question: JevQuestion<C>,
  timeoutMs = 2000,
): Promise<JevReply<C>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<JevReply<C>>((resolve) => {
    timer = setTimeout(
      () => resolve({ asked: true, ok: false, reason: `超过 ${timeoutMs} 毫秒没回` }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([port.ask(question), timeout]);
  } catch (error) {
    return {
      asked: true,
      ok: false,
      reason: `调用出错：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface AskOptions {
  jev?: JevPort;
  timeoutMs?: number;
}

export async function triageFailure(
  evidence: FailureEvidence,
  options: AskOptions & { policy?: Partial<FailurePolicy> } = {},
): Promise<FailureVerdict> {
  const first = classifyFailure(evidence, options.policy);
  if (!first.jevQuestion) return first;
  const reply = await askJev(options.jev ?? NO_JEV, first.jevQuestion, options.timeoutMs);
  return classifyFailure({ ...evidence, jev: reply }, options.policy);
}

export async function judgeStallWithJev(
  facts: StallFacts,
  options: AskOptions & { policy?: Partial<StallPolicy> } = {},
): Promise<StallVerdict> {
  const first = judgeStall(facts, options.policy);
  if (!first.jevQuestion) return first;
  const reply = await askJev(options.jev ?? NO_JEV, first.jevQuestion, options.timeoutMs);
  return judgeStall({ ...facts, jev: reply }, options.policy);
}
