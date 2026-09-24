// 分诊之后：清楚就开工；看不懂就在任务里追问；没判出来按默认走，不当成「否」（设计十一）。

import { normalizeHolds } from '../holds.ts';

export interface TriageVerdict {
  /** true 清楚；false 有说不清的地方；null 没判出来。 */
  clear: boolean | null;
  /** 该问创始人的那一句。 */
  question?: string;
  /** 三行以内的「AI 理解为」。 */
  summary?: string;
  size?: 'S' | 'M' | 'L';
  /** 是不是 UI 活（GPT 族禁入靠这个）。 */
  ui?: boolean;
  /** 会不会碰对外发布（release）、花钱（spend）、删数据（delete）：碰了的，每个子任务合并前都要人批。 */
  holds?: string[];
}

export interface TriageInput {
  verdict: TriageVerdict;
  /** 已经追问过几次。 */
  asked: number;
  maxQuestions: number;
}

export type TriageDecision =
  | { action: 'proceed'; assumed: boolean; note: string; holds: string[] }
  | { action: 'ask'; question: string };

export function decideTriage(input: TriageInput): TriageDecision {
  const { verdict } = input;
  const holds = normalizeHolds(verdict.holds);
  if (verdict.clear === true) return { action: 'proceed', assumed: false, note: '需求清楚', holds };
  if (verdict.clear === null)
    return { action: 'proceed', assumed: true, note: '分诊没判出来，按默认理解开工', holds };
  const question = verdict.question?.trim();
  if (!question)
    return {
      action: 'proceed',
      assumed: true,
      note: '说有不清楚的地方但没给出要问的话，按默认理解开工',
      holds,
    };
  if (input.asked >= input.maxQuestions) {
    return {
      action: 'proceed',
      assumed: true,
      note: `已经追问 ${input.asked} 次，按写明的假设继续`,
      holds,
    };
  }
  return { action: 'ask', question };
}
