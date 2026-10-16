// taskSpend 活动的折算（#2830）：库交原始四样，这里折成「折算 token」（缓存读乘 CACHE_READ_TOKEN_WEIGHT，其余乘 1）。
// 折算放在活动里算、结果记进工作流历史，工作流只读结果里的数，不重算——在途的单重放时拿到的是历史里记的老结果，判法不变。
import { budgetTokensOf } from '@fleet-dao/shared';
import { CACHE_READ_TOKEN_WEIGHT } from './limits.ts';
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
  const weighted = budgetTokensOf(row);
  // 估的下限是按这张单量到的行的速率估的，没有四样的分项：按量到的那部分折算比例一起折
  const weightedEstimated = row.tokens > 0 ? Math.round((row.estimated * weighted) / row.tokens) : 0;
  return {
    tokens: row.tokens,
    runs: row.runs,
    unmetered: row.unmetered,
    estimated: row.estimated,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    weighted,
    weightedEstimated,
    cacheReadWeight: CACHE_READ_TOKEN_WEIGHT,
  };
}
