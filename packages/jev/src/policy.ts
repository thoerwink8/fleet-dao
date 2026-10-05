// 管住 Jev 的两条线：每天最多问几道、按量计费的后端每天最多花多少。默认值只在这一处；驾驶舱设置里配了就以设置为准（readPolicy）。

export interface JevPolicy {
  /** 每天最多问几道题（一次问几道算几次）；设置里的 judge.dailyCallLimit 优先。 */
  dailyCallLimit: number;
  /**
   * 按量计费的后端（TypeSafe）每天最多花多少美元，到了就停调、走默认。默认沿用旧系统的日帽，
   * 也是额度读取器里 Jev 那个池的上限（deploy/examples/quota.example.json）；设置里的 judge.dailyUsdCap 优先。
   */
  dailyUsdCap: number;
}

export const DEFAULT_POLICY: JevPolicy = {
  dailyCallLimit: 200,
  dailyUsdCap: 0.3,
};

/** 题库里每道题把握线的初值；登记进库之后以库里那一行为准（驾驶舱可以改）。 */
export const DEFAULT_CONFIDENCE_LINE = 0.7;

/** 设置表里的键（值是 JSON）。judge.dailyCallLimit 已在 @fleet-dao/shared 的 SETTING_SCHEMAS 里。 */
export const POLICY_SETTING_KEYS = {
  dailyCallLimit: 'judge.dailyCallLimit',
  dailyUsdCap: 'judge.dailyUsdCap',
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
  const usd = settings[POLICY_SETTING_KEYS.dailyUsdCap];
  if (usd !== undefined) {
    if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) policy.dailyUsdCap = usd;
    else problems.push(`${POLICY_SETTING_KEYS.dailyUsdCap} 要是非负的美元数，读到 ${JSON.stringify(usd)}`);
  }
  return { policy, problems };
}
