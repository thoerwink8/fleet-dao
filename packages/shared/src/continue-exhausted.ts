// 继续次数用满之后，命令行和驾驶舱认引擎停住时写的那一句，不再发「继续」。
// 次数写在句子里（task-runtime 的 exhaustRounds：已继续 N 次仍没过，交指挥官），不另存一个计数。

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
