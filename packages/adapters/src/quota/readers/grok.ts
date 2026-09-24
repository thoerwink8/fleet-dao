// Grok Build（xAI 订阅）：读 grok CLI 里 /usage 弹窗用的账单接口 `billing?format=credits`，拿 CLI 已登录的 OAuth 令牌只读调用。
// 令牌过期不自己续：续期会轮换 refresh_token，CLI 手里那份就作废了。过期只报「要让 grok 自己续一下」。
import type { Reader } from '../context.ts';
import { fetchJson } from '../http.ts';
import type { GrokBillingConfig, QuotaReading, SubscriptionInfo } from '../types.ts';
import { QuotaReadError } from '../types.ts';
import { expandHome, isRecord, num, pruned, toIso } from '../util.ts';

const SOURCE = 'grok-billing';
export const DEFAULT_GROK_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const DEFAULT_GROK_CLIENT_VERSION = '1.0.41';

const PERIOD_WINDOW: Record<string, QuotaReading['window']> = {
  USAGE_PERIOD_TYPE_WEEKLY: '7d',
};

/**
 * billing?format=credits → 窗口读数。creditUsagePercent 是账号这一期的总用量（百分比），账号级；
 * 分产品的百分比（productUsage）只进说明——我们只用 Grok Build 一个产品，拆成模型组窗口会对不上路由。
 */
export function readingsFromGrokBilling(
  body: unknown,
  ctx: { poolId: string; readAt: string },
): { windows: QuotaReading[]; notes: string[] } {
  const config = isRecord(body) ? body.config : undefined;
  if (!isRecord(config)) throw new QuotaReadError('bad_response', 'Grok 账单回包里没有 config');
  const percent = num(config.creditUsagePercent);
  if (percent === undefined)
    throw new QuotaReadError('bad_response', 'Grok 账单回包里没有 creditUsagePercent');
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

export const readGrokBilling: Reader = async (ctx) => {
  const pool = ctx.pool as GrokBillingConfig;
  const authFile = expandHome(pool.authFile ?? '~/.grok/auth.json', ctx.homeDir);
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
  if (!entry)
    throw new QuotaReadError(
      'no_credentials',
      `Grok 登录文件 ${authFile} 里没有令牌：要在这台机器上 grok login`,
    );
  const expiresAt = Date.parse(String(entry.expires_at ?? ''));
  if (Number.isFinite(expiresAt) && expiresAt <= ctx.now().getTime() + 60_000) {
    throw new QuotaReadError(
      'auth',
      'Grok 的登录令牌已过期：读取器不自己续期（会把 CLI 手里的 refresh_token 轮换掉），等 grok 下次运行自己续，或手动跑一次 grok',
    );
  }
  const baseUrl = (pool.baseUrl ?? DEFAULT_GROK_BASE_URL).replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${entry.key as string}`,
    'x-grok-client-version': pool.clientVersion ?? DEFAULT_GROK_CLIENT_VERSION,
    Accept: 'application/json',
  };

  const get = (path: string): Promise<unknown> =>
    fetchJson(ctx, {
      name: `Grok ${path}`,
      url: `${baseUrl}${path}`,
      init: { headers },
      authHint: '要在这台机器上重新 grok login',
    });

  // 账单是主数；订阅档位是补充（回包里有邮箱等身份信息，只取 subscriptionTier）。
  const [billing, user] = await Promise.all([
    get('/billing?format=credits'),
    get('/user?include=subscription').catch((e: unknown) => e),
  ]);
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
