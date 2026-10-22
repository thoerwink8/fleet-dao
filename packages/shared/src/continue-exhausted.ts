// 继续次数用满之后，命令行和驾驶舱认引擎停住时写的那一句，不再发「继续」。
// 次数写在句子里（task-runtime 的 exhaustRounds：已继续 N 次仍没过，交指挥官），不另存一个计数。
// 总轮数到顶（#3603）：引擎贴「本机做」交还本机、停下；「继续」要带原因才放行。标题也由这里给，引擎和入口认同一句。
// 引擎工作流也引这个文件（@fleet-dao/shared/continue-exhausted）：只放纯函数，不引别的模块。

const MARK = /已继续 (\d+) 次仍没过/;

/**
 * 停住原因是继续次数用满时，回给人看的那一句；不是这种停住回 null（别的原因仍可以继续）。
 * N 用原因里的次数，和引擎写下的 MAX_ROUND_RESETS 对得上。
 */
export function continueExhausted(why: string | null | undefined): string | null {
  if (!why) return null;
  const n = MARK.exec(why)?.[1];
  if (!n) return null;
  return `继续次数已用满（${n} 次），继续无效；要重开用 redo`;
}

/**
 * 一张单动手最多累计几轮（#3603）：跨「继续」累计，继续不清零。到了交还本机。
 * 重做另起新一代也按历代累计数这个上限（#3625，conventions 的 totalRoundsHoldOf）：引擎和入口共用这一个数。
 */
export const MAX_TOTAL_ROUNDS = 6;

/** 总轮数到顶的停下标题（#3603）：n 是这次停下时的上限（累计动手轮数）。 */
export function totalRoundsTitle(n: number): string {
  return `动手累计 ${n} 轮仍没合，交还本机`;
}

const TOTAL_MARK = /动手累计 (\d+) 轮仍没合，交还本机/;

/**
 * 停住原因是总轮数到顶时，回给人看的那一句（「继续」不带原因不放行）；不是这种停住回 null。
 * 引擎自己也会拒掉不带原因的「继续」，入口先拦是为了当场告诉人，不让信号白发。
 */
export function continueNeedsReason(why: string | null | undefined): string | null {
  if (!why) return null;
  const n = TOTAL_MARK.exec(why)?.[1];
  if (!n) return null;
  return `这张单动手累计 ${n} 轮仍没合，已交还本机：「继续」要写明为什么还值得接着做（命令行 --note，驾驶舱填原因）`;
}
