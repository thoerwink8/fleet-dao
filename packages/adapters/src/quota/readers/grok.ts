// Grok Build（xAI 订阅）：读 grok CLI 里 /usage 弹窗用的账单接口 `billing?format=credits`，拿 CLI 已登录的 OAuth 令牌只读调用。
// 访问令牌过期不自己续：续期会轮换 refresh_token，CLI 手里那份就作废。登录文件里还有 refresh_token 时报 auth_refreshable
// （等 grok 下次运行自己续，或由引擎以会话用户跑一次 `grok models` 让 CLI 续，见 refreshGrokLogin）。没有 refresh_token、
// 或 CLI / 上游已经拒绝，才是 auth，要人重新 grok login。
// 取舍：不给看门狗加宽限。宽限只少报「没按期跑成」，读数仍旧，选路继续把主力 grok 按「额度没读成」排后面。
import { errMessage } from '@fleet-dao/shared/util';
import type { Reader, ReaderContext } from '../context.ts';
import { fetchJson } from '../http.ts';
import type { GrokBillingConfig, QuotaReading, SubscriptionInfo } from '../types.ts';
import { QuotaReadError } from '../types.ts';
import { expandHome, isRecord, num, pruned, redact, toIso } from '../util.ts';

const SOURCE = 'grok-billing';
export const DEFAULT_GROK_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const DEFAULT_GROK_CLIENT_VERSION = '1.0.41';
/**
 * 访问令牌还能由 CLI 续时，多久没读成再找人。和看门狗的额度读数过期线（db 的 QUOTA_STALE_AFTER_MS，30 分钟）同一条：
 * 到了这条线，调度已经不把这个池当「还够」。引擎测试钉着两边相等。
 */
export const GROK_TOKEN_SELF_HEAL_MINUTES = 30;
/** 提前一分钟就当过期：别拿马上失效的访问令牌去打账单。 */
const TOKEN_SKEW_MS = 60_000;
/** CLI 明说续不上、要重新登录。一时连不上（auth refresh failed，不带 grok login）不算。 */
const LOGIN_DEAD =
  /Not signed in\.|Run `grok login`|grok login --device-code|Auth recovery exhausted|Authentication could not be refreshed|Authentication rejected by server|Your session has expired|Token expired\./i;

const PERIOD_WINDOW: Record<string, QuotaReading['window']> = {
  USAGE_PERIOD_TYPE_WEEKLY: '7d',
};

type JsonShape = 'missing' | 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean';

const jsonShape = (value: unknown): JsonShape => {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
};

const billingFieldProblem = (field: string, value: unknown, detail: string): QuotaReadError =>
  new QuotaReadError(
    'bad_response',
    `Grok 账单字段 ${field} 类型 ${jsonShape(value)}：${detail}（仅保留字段名和类型）`,
  );

/**
 * billing?format=credits → 窗口读数。creditUsagePercent 是账号这一期的总用量（百分比），账号级；
 * 分产品的百分比（productUsage）只进说明——我们只用 Grok Build 一个产品，拆成模型组窗口会对不上路由。
 */
export function readingsFromGrokBilling(
  body: unknown,
  ctx: { poolId: string; readAt: string },
): { windows: QuotaReading[]; notes: string[] } {
  if (!isRecord(body)) {
    throw billingFieldProblem('config', body, '读取器预期对象');
  }
  const config = body.config;
  if (config === undefined) {
    throw billingFieldProblem('config', config, '缺少字段');
  }
  if (!isRecord(config)) {
    throw billingFieldProblem('config', config, '读取器预期对象');
  }
  const rawPercent = config.creditUsagePercent;
  if (rawPercent === undefined) {
    throw billingFieldProblem('config.creditUsagePercent', rawPercent, '缺少字段');
  }
  const percent = num(rawPercent);
  if (percent === undefined) {
    const detail =
      jsonShape(rawPercent) === 'string'
        ? '字符串不是可解析的数字'
        : jsonShape(rawPercent) === 'number'
          ? '数字不是有限数'
          : '类型不支持数字读取';
    throw billingFieldProblem('config.creditUsagePercent', rawPercent, detail);
  }
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const periodType = typeof period.type === 'string' ? period.type : undefined;
  const notes: string[] = [];
  const window = (periodType && PERIOD_WINDOW[periodType]) || 'other';
  if (window === 'other') notes.push(`账期类型 ${periodType ?? '空'} 没见过，窗口按原样收`);
  const windows: QuotaReading[] = [
    pruned<QuotaReading>({
      poolId: ctx.poolId,
      window,
      label: periodType
        ? `credits:${periodType.replace(/^USAGE_PERIOD_TYPE_/, '').toLowerCase()}`
        : 'credits',
      unit: 'percent',
      used: percent,
      limit: 100,
      utilization: percent / 100,
      resetsAt: toIso(period.end ?? config.billingPeriodEnd),
      reading: 'measured',
      readAt: ctx.readAt,
      source: SOURCE,
    }),
  ];

  if (Array.isArray(config.productUsage)) {
    const parts = config.productUsage
      .filter(isRecord)
      .map((p) => `${String(p.product ?? '?')} ${num(p.usagePercent) ?? '?'}%`);
    if (parts.length) notes.push(`分产品：${parts.join('，')}`);
  }
  const cap = isRecord(config.onDemandCap) ? num(config.onDemandCap.val) : undefined;
  const used = isRecord(config.onDemandUsed) ? num(config.onDemandUsed.val) : undefined;
  if (cap === 0 && (used === undefined || used === 0)) notes.push('按需付费上限为 0：超出套餐不会自动扣钱');
  else if (cap !== undefined || used !== undefined) {
    notes.push(`按需付费：上限 ${cap ?? '空'}、已用 ${used ?? '空'}（单位没核实，没收成窗口）`);
  }
  return { windows, notes };
}

interface GrokAuth {
  key: string;
  /** 登录文件里有非空 refresh_token。值不离开这个函数。 */
  hasRefresh: boolean;
  /** 解析不出 expires_at 时是 NaN：不当成已过期，交给上游拒绝再判。 */
  expiresAt: number;
}

const tokenStale = (expiresAt: number, nowMs: number): boolean =>
  Number.isFinite(expiresAt) && expiresAt <= nowMs + TOKEN_SKEW_MS;

/** 访问令牌过期、refresh_token 还在：不进「不会自己好」。多久没好再找人写在这句话里。 */
const refreshable = (extra?: string): QuotaReadError =>
  new QuotaReadError(
    'auth_refreshable',
    `Grok 的登录令牌已过期，登录文件里还有 refresh_token：读取器不自己续期（会把 CLI 手里的 refresh_token 轮换掉），等 grok 下次运行会自己续；超过 ${GROK_TOKEN_SELF_HEAL_MINUTES} 分钟还没读成再找人${extra ? `（${extra}）` : ''}`,
  );

const mustLogin = (why: string): QuotaReadError =>
  new QuotaReadError('auth', `Grok 的登录凭据失效（${why}）：要在这台机器上重新 grok login`);

async function readGrokAuth(ctx: ReaderContext, authFile: string): Promise<GrokAuth> {
  let entries: unknown[];
  try {
    const doc: unknown = JSON.parse(await ctx.readFile(authFile));
    entries = isRecord(doc) ? Object.values(doc) : [];
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '不是 JSON';
    throw new QuotaReadError('no_credentials', `读不到 Grok 登录文件 ${authFile}（${code}）`);
  }
  const entry = entries.find(
    (e): e is Record<string, unknown> => isRecord(e) && typeof e.key === 'string' && !!e.key,
  );
  if (!entry) {
    throw new QuotaReadError(
      'no_credentials',
      `Grok 登录文件 ${authFile} 里没有令牌：要在这台机器上 grok login`,
    );
  }
  const refresh = entry.refresh_token;
  return {
    key: entry.key as string,
    hasRefresh: typeof refresh === 'string' && refresh.length > 0,
    expiresAt: Date.parse(String(entry.expires_at ?? '')),
  };
}

export const readGrokBilling: Reader = async (ctx) => {
  const pool = ctx.pool as GrokBillingConfig;
  const authFile = expandHome(pool.authFile ?? '~/.grok/auth.json', ctx.homeDir);
  let auth = await readGrokAuth(ctx, authFile);

  // 一轮最多让 CLI 续一次（和账单 401 共用这一次）。读取器不读、不写 refresh_token。
  const refreshOnce = (): Promise<void> => {
    const refresh = ctx.refreshLogin;
    if (!refresh) return Promise.reject(new Error('这一轮没有由引擎起的 grok 命令'));
    return ctx.shared('grok-login-refresh', () => refresh());
  };
  const nudge = async (whenStillStale: string): Promise<void> => {
    try {
      await refreshOnce();
    } catch (e) {
      const why = redact(errMessage(e), 300);
      if (LOGIN_DEAD.test(why)) throw mustLogin(why);
      throw refreshable(why);
    }
    auth = await readGrokAuth(ctx, authFile);
    if (!tokenStale(auth.expiresAt, ctx.now().getTime())) return;
    if (!auth.hasRefresh) throw mustLogin(whenStillStale);
    throw refreshable(whenStillStale);
  };

  if (tokenStale(auth.expiresAt, ctx.now().getTime())) {
    if (!auth.hasRefresh) throw mustLogin('访问令牌已过期，登录文件里没有 refresh_token');
    // 没接上续期命令：只报还能续，不发请求、不碰 refresh_token。
    if (!ctx.refreshLogin) throw refreshable();
    await nudge('已让 grok 跑过一次，访问令牌仍过期');
  }

  const baseUrl = (pool.baseUrl ?? DEFAULT_GROK_BASE_URL).replace(/\/+$/, '');
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${auth.key}`,
    'x-grok-client-version': pool.clientVersion ?? DEFAULT_GROK_CLIENT_VERSION,
    Accept: 'application/json',
  });

  const get = (path: string): Promise<unknown> =>
    fetchJson(ctx, {
      name: `Grok ${path}`,
      url: `${baseUrl}${path}`,
      init: { headers: headers() },
      authHint: '要在这台机器上重新 grok login',
    });

  // 账单是主数。本地还没过期却被拒：有 refresh_token 且引擎接了续期命令时，让 CLI 续一次再读；
  // 没接上、或续完仍被拒，按凭据失效（auth）交回，不说成还会自己好。
  let billing: unknown;
  try {
    billing = await get('/billing?format=credits');
  } catch (e) {
    if (!(e instanceof QuotaReadError) || e.code !== 'auth' || !auth.hasRefresh || !ctx.refreshLogin) throw e;
    try {
      await refreshOnce();
    } catch (re) {
      const why = redact(errMessage(re), 300);
      throw new QuotaReadError(
        'auth',
        `Grok 登录失效：${e.message}；续期命令（grok models）也没跑成：${why}。要在这台机器上重新 grok login`,
      );
    }
    auth = await readGrokAuth(ctx, authFile);
    try {
      billing = await get('/billing?format=credits');
    } catch (e2) {
      if (!(e2 instanceof QuotaReadError) || e2.code !== 'auth') throw e2;
      throw mustLogin('已让 grok 跑过一次，账单接口仍拒绝登录');
    }
  }
  const user = await get('/user?include=subscription').catch((e: unknown) => e);
  const out = readingsFromGrokBilling(billing, { poolId: pool.poolId, readAt: ctx.fetchedAt });
  const notes = [...out.notes];
  const result: Awaited<ReturnType<Reader>> = { windows: out.windows, notes };
  if (user instanceof Error) notes.push(`订阅档位没读到：${user.message}`);
  else if (isRecord(user) && typeof user.subscriptionTier === 'string' && user.subscriptionTier) {
    const subscription: SubscriptionInfo = { plan: user.subscriptionTier };
    result.subscription = subscription;
  }
  return result;
};
