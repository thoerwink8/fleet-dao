/** 收缩用的先验强度：往本档平均拉这么多单。和引擎默认选路策略 trackScore.priorTasks 同一个数。 */
export const TRACK_PRIOR_TASKS = 4;

/**
 * 收缩后的质量下界。m = (一段过 + prior × 本档平均) / (单数 + prior)，分 = m − √(m(1−m)/(单数+prior))。
 * 本档平均由调用方按这一档全部模型的一段过之和 / 第一段之和算好。选路和驾驶舱动手战绩表用同一份。
 */
export function tierQuality(onePass: number, tasks: number, average: number, prior: number): number {
  const denom = tasks + prior;
  if (denom <= 0) return 0;
  const m = Math.min(1, Math.max(0, (onePass + prior * average) / denom));
  return m - Math.sqrt((m * (1 - m)) / denom);
}
