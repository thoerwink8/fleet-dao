// 管住 Jev 的几条线。默认值只在这一处；驾驶舱设置里配了就以设置为准（readPolicy），页面和文档从这里读，不手写数字。

export interface JevPolicy {
  /** 攒满多少条「有把握、有真值」的判定，才考虑从只记不拦转真拦。 */
  minSamples: number;
  /** 准确率线：生产判定和巡检考题都要不低于它。 */
  accuracyLine: number;
  /** 一次巡检考试至少答出几道才作数，少于它算「没考成」。 */
  examMinAnswered: number;
  /** 一次巡检考试至少答出几成才作数（答出 = 答在题面选项里，不论把握）。 */
  examAnsweredShare: number;
  /** 只记不拦超过这么多天还没攒够样本，日报报「影子停滞」。 */
  shadowStallDays: number;
  /** 每天最多问几道题（一次问几道算几次）；设置里的 judge.dailyCallLimit 优先。 */
  dailyCallLimit: number;
}

export const DEFAULT_POLICY: JevPolicy = {
  minSamples: 50,
  accuracyLine: 0.9,
  examMinAnswered: 3,
  examAnsweredShare: 0.8,
  shadowStallDays: 14,
  dailyCallLimit: 200,
};

/** 题库里每道题把握线的初值；登记进库之后以库里那一行为准（驾驶舱可以改）。 */
export const DEFAULT_CONFIDENCE_LINE = 0.7;

/** 设置表里的键（值是 JSON）。judge.dailyCallLimit 已在 @fleet-dao/shared 的 SETTING_SCHEMAS 里；其余两个待加。 */
export const POLICY_SETTING_KEYS = {
  dailyCallLimit: 'judge.dailyCallLimit',
  accuracyLine: 'judge.accuracyLine',
  minSamples: 'judge.minSamples',
} as const;

/** 设置里读到的值合并进默认值；读到的不合法就不用它（照默认），并把问题交给调用方记下。 */
export function mergePolicy(
  base: JevPolicy,
  settings: Readonly<Record<string, unknown>>,
): { policy: JevPolicy; problems: string[] } {
  const policy = { ...base };
  const problems: string[] = [];
  const limit = settings[POLICY_SETTING_KEYS.dailyCallLimit];
  if (limit !== undefined) {
    if (Number.isInteger(limit) && (limit as number) >= 0) policy.dailyCallLimit = limit as number;
    else problems.push(`${POLICY_SETTING_KEYS.dailyCallLimit} 要是非负整数，读到 ${JSON.stringify(limit)}`);
  }
  const line = settings[POLICY_SETTING_KEYS.accuracyLine];
  if (line !== undefined) {
    if (typeof line === 'number' && line > 0 && line <= 1) policy.accuracyLine = line;
    else
      problems.push(`${POLICY_SETTING_KEYS.accuracyLine} 要是 (0, 1] 之间的数，读到 ${JSON.stringify(line)}`);
  }
  const min = settings[POLICY_SETTING_KEYS.minSamples];
  if (min !== undefined) {
    if (Number.isInteger(min) && (min as number) > 0) policy.minSamples = min as number;
    else problems.push(`${POLICY_SETTING_KEYS.minSamples} 要是正整数，读到 ${JSON.stringify(min)}`);
  }
  return { policy, problems };
}
