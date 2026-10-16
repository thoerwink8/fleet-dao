// 「要你拍」拍完之后系统照着做的结果（#2353，answer.execution）：卡上那一行和弹出的提示用同一份判法。
// 三种：做成了（done）、交给引擎还在做（queued，删工作树要等下一轮对账）、没做成（failed，卡留着，上面写原因，可以再选一次）。
// 老数据、假数据没有 execution 的按答案本身算「记下了」（pending）。
import type { AnswerNotificationResult, Notification } from '../api/types';

export type DecisionResultKind = 'done' | 'queued' | 'failed' | 'pending';

export interface DecisionResult {
  kind: DecisionResultKind;
  /** 一句话：做了什么，或为什么没做成。 */
  text: string;
}

type Answer = NonNullable<Notification['answer']>;

export function decisionResult(answer: Answer): DecisionResult {
  const e = answer.execution;
  if (!e) return { kind: 'pending', text: '记下了，还没回执' };
  if (!e.ok) return { kind: 'failed', text: e.text };
  return { kind: e.queued ? 'queued' : 'done', text: e.text };
}

/** 拍完弹的提示：做成了绿、交给引擎了蓝、没做成红（卡留着，可以再选）。 */
export function decisionToast(r: AnswerNotificationResult): {
  level: 'success' | 'info' | 'error';
  title: string;
  description: string;
} {
  const res = decisionResult(r.answer);
  const picked = r.answer.text;
  if (res.kind === 'failed') return { level: 'error', title: `没做成：${picked}`, description: res.text };
  if (res.kind === 'queued') return { level: 'info', title: `交给引擎了：${picked}`, description: res.text };
  if (res.kind === 'pending') return { level: 'info', title: `记下了：${picked}`, description: res.text };
  return { level: 'success', title: `照做了：${picked}`, description: res.text };
}
