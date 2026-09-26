// 问 Jev 的那一步：本目录里唯一要等网络的地方，只在活动里调（工作流里调会把不确定的东西带进历史）。
// 先纯函数判一次，认不出、拿不准才问；问完带着回答再用同一个纯函数判一次。默认不问。

import { classifyFailure } from './classify.ts';
import type { JevAskContext, JevPort, JevQuestion, JevReply } from './jev.ts';
import { judgeStall, type StallFacts, type StallPolicy, type StallVerdict } from './stall.ts';
import type { FailureEvidence, FailurePolicy, FailureVerdict, TriageChoice } from './types.ts';

/** 默认实现：不问（没给 Jev 端口时：测试、假端口）。生产的端口在 real/jev-port.ts。 */
export const NO_JEV: JevPort = {
  ask: async () => ({ asked: false, reason: '没接 Jev，默认不问' }),
};

/** 问一次。抛错、超时（预算 2 秒，盲设计题三臂的建议值）都当「没判出来」，不当成「否」。 */
export async function askJev<C extends string>(
  port: JevPort,
  question: JevQuestion<C>,
  timeoutMs = 2000,
  ctx?: JevAskContext,
): Promise<JevReply<C>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<JevReply<C>>((resolve) => {
    timer = setTimeout(
      () => resolve({ asked: true, ok: false, reason: `超过 ${timeoutMs} 毫秒没回` }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([port.ask(question, ctx), timeout]);
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
  /** 问的是谁、在干什么：记进判断记录，也喂给题里的证据。 */
  ctx?: JevAskContext;
}

/**
 * 失败分流，认不出才问 Jev；问过就把回答一起交回来（没问是 undefined）。会话端口要把回答带给工作流的失败分流：
 * 工作流不能自己问（会把网络上的不确定带进历史），拿着活动问回来的答案判就和重放无关了。
 */
export async function triageFailureAsked(
  evidence: FailureEvidence,
  options: AskOptions & { policy?: Partial<FailurePolicy> } = {},
): Promise<{ verdict: FailureVerdict; jev?: JevReply<TriageChoice> }> {
  const first = classifyFailure(evidence, options.policy);
  if (!first.jevQuestion) return { verdict: first };
  const jev = await askJev(options.jev ?? NO_JEV, first.jevQuestion, options.timeoutMs, options.ctx);
  return { verdict: classifyFailure({ ...evidence, jev }, options.policy), jev };
}

export async function triageFailure(
  evidence: FailureEvidence,
  options: AskOptions & { policy?: Partial<FailurePolicy> } = {},
): Promise<FailureVerdict> {
  return (await triageFailureAsked(evidence, options)).verdict;
}

export async function judgeStallWithJev(
  facts: StallFacts,
  options: AskOptions & { policy?: Partial<StallPolicy> } = {},
): Promise<StallVerdict> {
  const first = judgeStall(facts, options.policy);
  if (!first.jevQuestion) return first;
  const reply = await askJev(options.jev ?? NO_JEV, first.jevQuestion, options.timeoutMs, options.ctx);
  return judgeStall({ ...facts, jev: reply }, options.policy);
}
