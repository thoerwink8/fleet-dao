/**
 * 模型的强弱档（models.strength，目录 deploy/catalog.json 的 strength）：strong 强 / standard 标准 / light 轻。
 * 和单子的派工档（fast / medium / heavyweight，runs.tier）是两回事：派工档说这张单多难，强弱档说这个模型多强。
 * 没标（null）= 选路照以前（不按强弱档挪位、不同档分流）。
 */
export const MODEL_STRENGTHS = ['strong', 'standard', 'light'] as const;
export type ModelStrength = (typeof MODEL_STRENGTHS)[number];

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
