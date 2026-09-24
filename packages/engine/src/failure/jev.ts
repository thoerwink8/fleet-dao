// 问 Jev 的接口（设计第十一节「错误分流」「停滞预判」两个接入点）。Jev 本身在别的包里做；这里只定题目和回答的形状，
// 默认实现是「不问」（ask.ts 的 NO_JEV）。
// 能拦不能放：选项里只有能撤回的动作——挂起、停账号池、合并、删东西都不在选项里，Jev 选不出来。
// 把握低、只记不拦、连不上、答了题面外的，一律当「没判出来」走默认，不当成「否」。

/** 接在哪。也是 Jev 题库里这道题的编号。 */
export type JevSite = 'failure-triage' | 'stall-predict';

export interface JevQuestion<C extends string = string> {
  questionId: JevSite;
  /** 题面。 */
  prompt: string;
  /** 选项；unclear = 看不出来。 */
  options: readonly C[];
  /** 每个选项的白话说明。 */
  hints: Readonly<Record<C, string>>;
  /** 喂进去的材料：全文，不裁剪（旧系统实测：裁掉「无关」正文反而漏判）。 */
  sample: string;
  /** 把握度低于它 = 没判出来。 */
  confidenceFloor: number;
}

export type JevReply<C extends string = string> =
  /** 没问：没接 Jev（默认）、超了每天的调用上限…… */
  | { asked: false; reason: string }
  /** 问了没判出来：连不上、超时、答了题面外的选项。 */
  | { asked: true; ok: false; reason: string }
  /** shadow = 这道题还在「只记不拦」，答案不拿来做决定。 */
  | { asked: true; ok: true; choice: C; confidence: number; shadow: boolean; modelVersion?: string };

export interface JevPort {
  ask<C extends string>(question: JevQuestion<C>): Promise<JevReply<C>>;
}

/** 回答能不能拿来做决定：能用给出选项，不能用给出白话原因（写进结论的原因里）。 */
export function readJevReply<C extends string>(
  reply: JevReply<C> | undefined,
  question: Pick<JevQuestion<C>, 'options' | 'confidenceFloor'>,
): { use: C } | { skip: string } {
  if (!reply) return { skip: '没问 Jev' };
  if (!reply.asked) return { skip: `没问 Jev（${reply.reason}）` };
  if (!reply.ok) return { skip: `Jev 没判出来（${reply.reason}）` };
  if (!question.options.includes(reply.choice)) return { skip: `Jev 答了题面外的「${reply.choice}」` };
  if (!(reply.confidence >= 0 && reply.confidence <= 1)) return { skip: 'Jev 的把握度不在 0–1 之间' };
  if (reply.shadow) return { skip: `Jev 判「${reply.choice}」，这道题还在只记不拦` };
  if (reply.confidence < question.confidenceFloor) {
    return { skip: `Jev 判「${reply.choice}」，把握 ${reply.confidence} 低于 ${question.confidenceFloor}` };
  }
  return { use: reply.choice };
}
