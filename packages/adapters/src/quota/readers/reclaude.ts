// Claude 订阅·拼车组织：reclaude 的开放接口（网页「设置 → API Key」那把，Bearer 调），只读 GET。
// 读的是 reclaude 给每个拼车成员另设的 5 小时美元上限——/usage 看不见它：/usage 显示 16% 时真实请求已被拒过（design 第九节）。
// Key 是账号级的：不看这台机器挂哪个组织，不起 Claude Code、不调模型。独享组织的用量这套接口不给，仍走 claude-usage。
import type { Reader } from '../context.ts';
import { fetchJson } from '../http.ts';
import type { QuotaReading, ReclaudeCarpoolConfig, SubscriptionInfo } from '../types.ts';
import { QuotaReadError } from '../types.ts';
import { expandHome, isRecord, num, pruned, toIso } from '../util.ts';
import { normalizeStatus } from '../windows.ts';

const SOURCE = 'reclaude-carpool';
export const DEFAULT_RECLAUDE_BASE_URL = 'https://www.reclaude.ai';
/** 最短长度和卫生检查（packages/hygiene/src/rules.ts 的 token 规则）一致：读得了的 Key，推送前也扫得到。 */
const KEY_SHAPE = /^rck_[A-Za-z0-9_-]{20,}$/;

/**
 * GET /api/v1/carpool/quota → 拼车 5 小时美元窗口。
 * enabled 为 false = 上游明说这个成员没设上限 → 零个窗口；金额缺或认不出 → bad_response，不填 0。
 * 回包里的 account_id 是 reclaude 的账号编号，不往外带。
 */
export function readingsFromCarpoolQuota(
  body: unknown,
  ctx: { poolId: string; readAt: string },
): { windows: QuotaReading[]; notes: string[] } {
  if (!isRecord(body)) throw new QuotaReadError('bad_response', 'reclaude 拼车额度回包不是对象');
  if (typeof body.enabled !== 'boolean') {
    throw new QuotaReadError('bad_response', 'reclaude 拼车额度回包里没有 enabled，认不出开没开上限');
  }
  if (!body.enabled) return { windows: [], notes: ['reclaude 说这个拼车成员没设 5 小时上限'] };
  const limit = num(body.quota_usd);
  const used = num(body.used_usd);
  if (limit === undefined || used === undefined || !(limit > 0)) {
    throw new QuotaReadError(
      'bad_response',
      `reclaude 拼车额度的金额认不出（quota_usd=${String(body.quota_usd)}、used_usd=${String(body.used_usd)}）`,
    );
  }
  const notes: string[] = [];
  const resetsAt = toIso(body.resets_at_ms);
  if (!resetsAt) notes.push('没给清零时刻（resets_at_ms）');
  if (typeof body.notice_i18n_key === 'string' && /provisional/i.test(body.notice_i18n_key)) {
    notes.push('reclaude 标着这个上限是暂定的，以后可能调');
  }
  const windows: QuotaReading[] = [
    pruned<QuotaReading>({
      poolId: ctx.poolId,
      window: '5h',
      label: 'carpool_5h_usd',
      unit: 'usd',
      used,
      limit,
      utilization: used / limit,
      resetsAt,
      ...normalizeStatus(body.status ?? body.state),
      reading: 'measured',
      readAt: ctx.readAt,
      source: SOURCE,
    }),
  ];
  return { windows, notes };
}

/**
 * GET /api/v1/orgs → 拼车组织（type team）的到期日。组织编号、名字、邮箱一律不往外带。
 * 上游明说拼车池用不了（没有拼车组织、没分到 Claude 账号、已到期）→ 抛 upstream：额度读数再好看，这个池也派不了活。
 * 只是到期日认不出、有几个拼车组织分不清 → 记一笔，额度照收。
 */
export function carpoolSubscription(
  body: unknown,
  now: Date,
): { subscription?: SubscriptionInfo; notes: string[] } {
  const items = isRecord(body) && Array.isArray(body.items) ? body.items.filter(isRecord) : undefined;
  if (!items) return { notes: ['组织列表认不出，没读到到期日'] };
  const teams = items.filter((o) => o.type === 'team');
  if (teams.length === 0) {
    throw new QuotaReadError('upstream', 'reclaude 账号下没有拼车组织（到期或被收回）：拼车池用不了');
  }
  if (teams.length > 1) return { notes: [`账号下有 ${teams.length} 个拼车组织，不猜是哪个，没读到期日`] };
  const team = teams[0] as Record<string, unknown>;
  if (team.has_assigned_account === false) {
    throw new QuotaReadError('upstream', '拼车组织现在没分到 Claude 账号：会话起不来');
  }
  const expiresAt = toIso(team.subscription_expires_at);
  if (!expiresAt) return { notes: ['拼车组织没给到期日'] };
  if (Date.parse(expiresAt) <= now.getTime()) {
    throw new QuotaReadError('upstream', `拼车组织已于 ${expiresAt} 到期：拼车池用不了`);
  }
  return { subscription: { expiresAt }, notes: [] };
}

export const readReclaudeCarpool: Reader = async (ctx) => {
  const pool = ctx.pool as ReclaudeCarpoolConfig;
  const keyFile = expandHome(pool.keyFile, ctx.homeDir);
  let key: string;
  try {
    key = (await ctx.readFile(keyFile)).trim();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'ERR';
    throw new QuotaReadError('no_credentials', `读不到 reclaude API Key 文件 ${keyFile}（${code}）`);
  }
  if (!KEY_SHAPE.test(key)) {
    throw new QuotaReadError(
      'no_credentials',
      `reclaude API Key 文件 ${keyFile} 里不是一把 rck_ 开头的 Key（文件里只放 Key 这一行）`,
    );
  }
  const baseUrl = (pool.baseUrl ?? DEFAULT_RECLAUDE_BASE_URL).replace(/\/+$/, '');
  const get = (path: string): Promise<unknown> =>
    fetchJson(ctx, {
      name: `reclaude ${path}`,
      url: `${baseUrl}${path}`,
      init: { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } },
      authHint: '在 reclaude 网页「设置 → API Key」重新生成，换掉 Key 文件里那把',
    });

  // 额度是主数；组织接口连不上、5xx 只记一笔。它说 Key 不认（同一把 Key）或拼车池用不了，整池判失败。
  const [quota, orgs] = await Promise.all([
    get('/api/v1/carpool/quota'),
    get('/api/v1/orgs').catch((e: unknown) => e),
  ]);
  if (orgs instanceof QuotaReadError && orgs.code === 'auth') throw orgs;
  const out = readingsFromCarpoolQuota(quota, { poolId: pool.poolId, readAt: ctx.fetchedAt });
  const notes = [...out.notes];
  const result: Awaited<ReturnType<Reader>> = { windows: out.windows, notes };
  if (orgs instanceof Error) {
    notes.push(`到期日没读到：${orgs.message}`);
  } else {
    const sub = carpoolSubscription(orgs, ctx.now());
    notes.push(...sub.notes);
    if (sub.subscription) result.subscription = sub.subscription;
  }
  return result;
};
