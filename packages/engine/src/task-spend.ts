// taskSpend 活动的折算（#2859）：库交原始四样，这里用 shared 的 inputEquivalentOf 折成输入当量（预算判超没超看它）。
// 折算放在活动里算、结果记进工作流历史，工作流只读结果里的数，不重算——在途的单重放时拿到的是历史里记的老结果，判法不变。
import { inputEquivalentOf } from '@fleet-dao/shared';
import type { TaskSpendResult } from './task-contract.ts';

/** taskTokenSpend（库）的返回：合计、估的下限和原始四样。 */
export interface TaskSpendRow {
  tokens: number;
  runs: number;
  unmetered: number;
  estimated: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function toTaskSpendResult(row: TaskSpendRow): TaskSpendResult {
  const base = {
    tokens: row.tokens,
    runs: row.runs,
    unmetered: row.unmetered,
    estimated: row.estimated,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
  };
  const inputEquivalent = inputEquivalentOf(row);
  // 折不成（某一样读不到）：不给当量，不拿 0 顶；工作流见不到它就退回原来的 tokens / estimated
  if (inputEquivalent === undefined) return base;
  // 估的下限是按这张单量到的行的速率估的，没有四样的分项：按量到的那部分的折算比例一起折
  const inputEquivalentEstimated =
    row.tokens > 0 ? Math.round((row.estimated * inputEquivalent) / row.tokens) : 0;
  return { ...base, inputEquivalent, inputEquivalentEstimated };
}
