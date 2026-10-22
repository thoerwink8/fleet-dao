// 重做另起一代也按历代累计的动手轮数封顶（#3625）：#3603 的总轮数上限只数当前这一代工作流，task.redo / commander.redo 另起一代就从 0 再数，
// 等于绕过上限。起新一代之前先数这张单历代已经做完的动手轮数（库里 runs 表 segment=manual、outcome=done 的笔数，跨代，
// 不数被杀、起不来、没派出去这类没做成一轮的），累计到了上限就不再起新一代，改贴「本机做」交回本机并留言。
// 判据只有这一份，api（驾驶舱 / 命令行 task.redo）和引擎（指挥官 commander.redo）共用。
import { MAX_TOTAL_ROUNDS } from '@fleet-dao/shared/continue-exhausted';
import { LOCAL_LABEL } from './labels.ts';

/** 起新一代的两个入口。 */
export type TotalRoundsHoldAction = 'task.redo' | 'commander.redo';

const ACTION_WORDS: Record<TotalRoundsHoldAction, string> = {
  'task.redo': 'task.redo 重做',
  'commander.redo': '指挥官重做',
};

/** 库里一笔三段流水里数动手轮数要看的两项（SegmentRun 的子集）。 */
export interface RoundRunFact {
  segment: string;
  outcome?: string | null | undefined;
}

/** 这张单历代累计做完了几轮动手：segment=manual 且 outcome=done 的笔数。 */
export function implementRoundsDone(runs: readonly RoundRunFact[]): number {
  return runs.filter((r) => r.segment === 'manual' && r.outcome === 'done').length;
}

/** 起新一代之前的判决：累计已到上限，不再起，改交回本机。 */
export interface TotalRoundsHold {
  rounds: number;
  limit: number;
  /** 一句话原因（拒绝信息、操作记录、日志）。 */
  why: string;
  /** 留在单上的话。 */
  comment: string;
  /** 留言的幂等键：同一个累计数同一个键。 */
  key: string;
}

/**
 * 累计动手轮数没到上限回 null（照常起新一代）；到了回判决：不起新一代，调用方留言并贴「本机做」。
 * limit 默认 MAX_TOTAL_ROUNDS（#3603 那个数）；带原因的「继续」放宽过的上限不在这里数，重做按基础上限一刀切。
 */
export function totalRoundsHoldOf(
  rounds: number,
  action: TotalRoundsHoldAction,
  limit: number = MAX_TOTAL_ROUNDS,
): TotalRoundsHold | null {
  if (rounds < limit) return null;
  const word = ACTION_WORDS[action];
  return {
    rounds,
    limit,
    why: `这张单历代累计动手 ${rounds} 轮（上限 ${limit}）仍没合，${word}只会把累计清零再空转一遍：不另起新一代，已交回本机做`,
    comment: [
      `${word}被拦下了：这张单历代累计已经动手 ${rounds} 轮（上限 ${limit}，#3625）还没合，另起一代会把轮数清零再来一遍，等于绕过上限。`,
      '',
      `已贴「${LOCAL_LABEL}」交回本机做：本机 \`pnpm work claim\` 领走接着做；若判断引擎还值得再试，先摘掉「${LOCAL_LABEL}」并在单上写明原因。`,
    ].join('\n'),
    key: `total-rounds-hold:${action}:${rounds}`,
  };
}
