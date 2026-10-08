// Cursor：Dashboard 的只读接口（cursor 网页「用量」页用的同一套），拿已登录的 accessToken 调，不起对话。
// 一个账号分两个桶：Auto（含 Composer 等自家模型，成员表由接口给）与 API（点名的其它模型），各有百分比；另有账期美元。
import { errMessage } from '@fleet-dao/shared/util';
import type { Reader } from '../context.ts';
import { fetchJson } from '../http.ts';
import type { CursorDashboardConfig, QuotaReading, ScopeMembership, SubscriptionInfo } from '../types.ts';
import { QuotaReadError } from '../types.ts';
import { expandHome, isRecord, num, pruned, redact, toIso } from '../util.ts';

const SOURCE = 'cursor-dashboard';
export const DEFAULT_CURSOR_BASE_URL = 'https://api2.cursor.sh';
/** 只读方法：类型上只许这三个，别的方法名发不出去。 */
type Method = 'GetCurrentPeriodUsage' | 'GetPlanInfo' | 'GetHardLimit';

/**
 * GetCurrentPeriodUsage → 窗口读数。金额单位是美分。
 * planUsage 里每个 `<桶>PercentUsed` 收成一个模型组窗口（auto、api，以后新出的桶也照收）；
 * totalPercentUsed 是几个桶的合成数，不单独当窗口（当账号级会拿合成数去卡每个桶）。
 */
export function readingsFromPeriodUsage(
  body: unknown,
  ctx: { poolId: string; readAt: string },
): {
  windows: QuotaReading[];
  notes: string[];
  scopeModels?: Record<string, ScopeMembership>;
  periodEnd?: string;
} {
  if (!isRecord(body)) throw new QuotaReadError('bad_response', 'Cursor 回包不是对象');
  const plan = body.planUsage;
  if (!isRecord(plan)) throw new QuotaReadError('bad_response', 'Cursor 回包里没有 planUsage');
  const periodEnd = toIso(body.billingCycleEnd);
  const base = {
    poolId: ctx.poolId,
    reading: 'measured' as const,
    readAt: ctx.readAt,
    source: SOURCE,
    resetsAt: periodEnd,
  };
  const windows: QuotaReading[] = [];
  const notes: string[] = [];

  const spent = num(plan.totalSpend);
  const limit = num(plan.limit);
  if (spent !== undefined && limit !== undefined && limit > 0) {
    windows.push(
      pruned<QuotaReading>({
        ...base,
        window: 'month_usd',
        label: 'plan_usd',
        unit: 'usd',
        used: spent / 100,
        limit: limit / 100,
        utilization: spent / limit,
      }),
    );
  } else {
    notes.push('账期美元（totalSpend / limit）缺，没收');
  }

  let buckets = 0;
  for (const [key, value] of Object.entries(plan)) {
    const m = /^(.+)PercentUsed$/.exec(key);
    const bucket = m?.[1];
    if (!bucket || bucket === 'total') continue;
    const percent = num(value);
    if (percent === undefined) {
      notes.push(`${key} 不是数字，没收`);
      continue;
    }
    buckets++;
    windows.push(
      pruned<QuotaReading>({
        ...base,
        window: 'other',
        scope: bucket.toLowerCase(),
        label: `${bucket.toLowerCase()}_percent`,
        unit: 'percent',
        used: percent,
        limit: 100,
        utilization: percent / 100,
      }),
    );
  }

  if (windows.length === 0) {
    throw new QuotaReadError(
      'bad_response',
      `Cursor 回包里一个额度窗口都认不出（上游多半改了字段名）：${notes.join('；') || 'planUsage 里没有认得的字段'}`,
    );
  }
  if (buckets === 0) notes.push('没找到 Auto / API 桶的百分比（字段可能改名了），只剩账期美元，按桶卡不住');

  // 按需付费（超出套餐的部分）：实测只回了 {limitType}，没见过带数的样子——出现新字段只点名，不猜含义。
  const spend = body.spendLimitUsage;
  if (isRecord(spend)) {
    const extra = Object.keys(spend).filter((k) => k !== 'limitType');
    if (extra.length) notes.push(`按需付费一栏出现了没核实过的字段（${extra.join('、')}），没收成窗口`);
  }
  if (body.enabled === false) notes.push('Cursor 说这个账号的用量计量没开（enabled=false）');

  let scopeModels: Record<string, ScopeMembership> | undefined;
  const auto = Array.isArray(body.autoBucketModels)
    ? body.autoBucketModels.filter((x): x is string => typeof x === 'string')
    : undefined;
  if (auto?.length) {
    scopeModels = { auto: { in: auto } };
    if (windows.some((w) => w.scope === 'api')) scopeModels.api = { notIn: auto };
  } else if (buckets > 0) {
    notes.push('没读到 Auto 桶的模型名单：桶窗口只能按名字匹配模型，可能卡不准');
  }
  const out: {
    windows: QuotaReading[];
    notes: string[];
    scopeModels?: Record<string, ScopeMembership>;
    periodEnd?: string;
  } = { windows, notes };
  if (scopeModels) out.scopeModels = scopeModels;
  if (periodEnd) out.periodEnd = periodEnd;
  return out;
}

export const readCursorDashboard: Reader = async (ctx) => {
  const pool = ctx.pool as CursorDashboardConfig;
  const authFile = expandHome(pool.authFile ?? '~/.config/cursor/auth.json', ctx.homeDir);
  const baseUrl = (pool.baseUrl ?? DEFAULT_CURSOR_BASE_URL).replace(/\/+$/, '');

  const call = (method: Method, token: string): Promise<unknown> =>
    fetchJson(ctx, {
      name: `Cursor ${method}`,
      url: `${baseUrl}/aiserver.v1.DashboardService/${method}`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
        },
        body: '{}',
      },
      authHint: '要在这台机器上重新 cursor-agent login',
    });

  // 读登录文件里的令牌。读不到、不是 JSON、里面没有 accessToken 都报 no_credentials，原因只写路径和现象，不写令牌内容。
  const whyOf = (e: unknown): { why: string; enoent: boolean } => {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      why: code ?? (e instanceof SyntaxError ? '不是 JSON' : (e as Error).message),
      enoent: code === 'ENOENT',
    };
  };
  const noCred = (when: string, why: string, tail = ''): QuotaReadError =>
    new QuotaReadError(
      'no_credentials',
      `没有可用的 Cursor 凭据：${when}Cursor 登录文件（${authFile}）读不到：${why}${tail}。要在这台机器上 cursor-agent login`,
    );
  const parseToken = async (): Promise<string> => {
    const token = (JSON.parse(await ctx.readFile(authFile)) as Record<string, unknown>).accessToken;
    if (typeof token !== 'string' || !token) throw new Error('里面没有 accessToken');
    return token;
  };
  const readToken = async (when: string): Promise<string> => {
    try {
      return await parseToken();
    } catch (e) {
      throw noCred(when, whyOf(e).why);
    }
  };
  const httpOf = (e: QuotaReadError) => /HTTP (\d+)/.exec(e.message)?.[1] ?? '401/403';

  // 登录文件会在 cursor-agent 会话起停时被删了重写。读到 ENOENT 时和令牌被拒一样：以会话用户跑一次
  // `cursor-agent status`（ctx.refreshLogin）把文件写回来，再读一次。一轮最多刷新一次（和下面被拒共用 cursor-login-refresh）。
  // 文件在但不是令牌、没有刷新手段：照旧 no_credentials，不刷新。刷新命令没跑成也报 no_credentials，不当成已刷新。
  let usable: string;
  try {
    usable = await parseToken();
  } catch (e) {
    const { why, enoent } = whyOf(e);
    const refresh = ctx.refreshLogin;
    if (!enoent || !refresh) throw noCred('', why);
    try {
      await ctx.shared('cursor-login-refresh', () => refresh());
    } catch (re) {
      throw new QuotaReadError(
        'no_credentials',
        `没有可用的 Cursor 凭据：Cursor 登录文件（${authFile}）读不到：${why}；刷新令牌的命令（cursor-agent status）也没跑成：${redact(errMessage(re))}。要人在这台机器上检查 cursor-agent，必要时 cursor-agent login`,
      );
    }
    try {
      usable = await parseToken();
    } catch (e2) {
      throw noCred('', whyOf(e2).why, '；已刷新一次仍读不到');
    }
  }

  // 登录令牌几个小时就过期，但 cursor-agent 自己会续：令牌被拒（401/403）时同样刷新一次，成功后重读再调一次；仍被拒才报「登录失效」。
  // 连不上、5xx 这类跟凭据无关的失败原样抛出，不刷新。上面 ENOENT 若已刷新过，这里的 shared 不会再跑第二次。
  let period: unknown;
  try {
    period = await call('GetCurrentPeriodUsage', usable);
  } catch (e) {
    if (!(e instanceof QuotaReadError) || e.code !== 'auth') throw e;
    const rejected = `登录令牌（${authFile}）被拒：HTTP ${httpOf(e)}`;
    const refresh = ctx.refreshLogin;
    if (!refresh) {
      throw new QuotaReadError(
        'auth',
        `Cursor 登录失效：${rejected}；这条读法没有刷新手段。要人在这台机器上 cursor-agent login`,
      );
    }
    try {
      await ctx.shared('cursor-login-refresh', () => refresh());
    } catch (re) {
      throw new QuotaReadError(
        'auth',
        `Cursor 登录失效：${rejected}；刷新令牌的命令（cursor-agent status）也没跑成：${redact(errMessage(re))}。要人在这台机器上检查 cursor-agent，必要时 cursor-agent login`,
      );
    }
    usable = await readToken('刷新后重读，');
    try {
      period = await call('GetCurrentPeriodUsage', usable);
    } catch (e2) {
      if (!(e2 instanceof QuotaReadError) || e2.code !== 'auth') throw e2;
      throw new QuotaReadError(
        'auth',
        `Cursor 登录失效：${rejected}；刷新过一次仍被拒（HTTP ${httpOf(e2)}），要人在这台机器上 cursor-agent login`,
      );
    }
  }

  // 账期用量是主数；套餐名和「允不允许按量」只是补充，读不到只记一笔说明，不算失败。
  const [planInfo, hardLimit] = await Promise.all([
    call('GetPlanInfo', usable).catch((e: unknown) => e),
    call('GetHardLimit', usable).catch((e: unknown) => e),
  ]);
  const out = readingsFromPeriodUsage(period, { poolId: pool.poolId, readAt: ctx.fetchedAt });
  const notes = [...out.notes];
  const subscription: SubscriptionInfo = {};
  if (out.periodEnd) subscription.expiresAt = out.periodEnd;
  if (planInfo instanceof Error) notes.push(`套餐名没读到：${planInfo.message}`);
  else if (isRecord(planInfo) && isRecord(planInfo.planInfo)) {
    const p = planInfo.planInfo;
    if (typeof p.planName === 'string' && p.planName) {
      subscription.plan = typeof p.price === 'string' && p.price ? `${p.planName}（${p.price}）` : p.planName;
    }
  }
  if (hardLimit instanceof Error) notes.push(`按量开关没读到：${hardLimit.message}`);
  else if (isRecord(hardLimit) && hardLimit.noUsageBasedAllowed === true) {
    notes.push('账号不允许按量计费：超出套餐不会自动扣钱');
  }
  const result: Awaited<ReturnType<Reader>> = { windows: out.windows, notes };
  if (subscription.plan || subscription.expiresAt) result.subscription = subscription;
  if (out.scopeModels) result.scopeModels = out.scopeModels;
  return result;
};
