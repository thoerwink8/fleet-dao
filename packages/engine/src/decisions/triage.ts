// 分诊之后：清楚就开工；看不懂的带选项和推荐问创始人、按推荐先做不等回答（#259 问他不挡路）；没判出来按默认走，
// 不当成「否」（设计十一）。

import { checkAsk } from '@fleet-dao/core';
import { normalizeHolds } from '../holds.ts';

export interface TriageVerdict {
  /** true 清楚；false 有说不清的地方；null 没判出来。 */
  clear: boolean | null;
  /** 该问创始人的那一句。 */
  question?: string;
  /** 说不清时给他挑的几个做法（2–4 个，#259）。 */
  options?: string[];
  /** 推荐哪个：照抄其中一个选项。 */
  recommend?: string;
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
  /** 已经追问过（或退回重交过）几次。 */
  asked: number;
  maxQuestions: number;
}

export type TriageDecision =
  /**
   * 往下走。ask = 说不清、带了选项和推荐：问他一句（发卡、记进库，不等回答），按推荐先做（#259）；推荐的排在选项第一个。
   * 这一项加进来之前的历史里没有它。
   */
  | {
      action: 'proceed';
      assumed: boolean;
      note: string;
      holds: string[];
      ask?: { question: string; options: string[]; recommended: string };
    }
  /** 老样子：问了停下等回答。#259 起不再判出这一种，只在这之前开工的历史里有（重放照老样子走）。 */
  | { action: 'ask'; question: string }
  /** 说不清却没带选项和推荐（或带得不对）：退回分诊，写明缺什么再交（#259：没带推荐的提问由引擎退回）。 */
  | { action: 'retriage'; question: string; why: string };

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
  const checked = checkAsk({ question, options: verdict.options, recommend: verdict.recommend });
  if (checked.ok) {
    const { ask } = checked;
    return {
      action: 'proceed',
      assumed: true,
      note: `分诊说不清：${ask.question}——问了创始人（不等回答），按推荐先做「${ask.recommended}」`,
      holds,
      ask: { question: ask.question, options: ask.options, recommended: ask.recommended },
    };
  }
  if (input.asked >= input.maxQuestions) {
    return {
      action: 'proceed',
      assumed: true,
      note: `已经退回 ${input.asked} 次还没带上选项和推荐，按写明的假设继续`,
      holds,
    };
  }
  return { action: 'retriage', question, why: checked.why };
}
