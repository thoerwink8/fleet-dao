// 互动限制「只限协作者」自动续期（公开仓；每次最长 6 个月）。「引擎」机器人要有 Administration 权限。
// 做法（docs/reference/github.md §5.2）：读 → 剩余不足 30 天才续（显式 six_months，不写默认只续一天）→ 回读到期时间确实往后推了才算（A8）。
// 读不成、写不成、账户级限制挡着（409）都报出来：没续成 ≠ 不用续。
import { z } from 'zod';
import { enc, type RepoRef, repoSlug } from './client.ts';
import type { ActivityContext, Deps } from './deps.ts';
import { GitHubError } from './errors.ts';

const LimitSchema = z.object({
  limit: z.string(),
  origin: z.string().optional(),
  expires_at: z.string().nullable().optional(),
});

export interface InteractionLimitInput {
  repo: RepoRef;
  /** 剩余不足这么多天就续，默认 30。 */
  renewWithinDays?: number | undefined;
}

export interface InteractionLimitResult {
  /** fresh = 还早，不用续；renewed = 续上了；set = 原来没有限制，这次设上了。 */
  action: 'fresh' | 'renewed' | 'set';
  expiresAt: string;
}

const DAY = 24 * 60 * 60 * 1000;

export async function renewInteractionLimit(
  deps: Deps,
  input: InteractionLimitInput,
  ctx: ActivityContext = {},
): Promise<InteractionLimitResult> {
  const { repo } = input;
  const slug = repoSlug(repo);
  const path = `/repos/${enc(repo.owner)}/${enc(repo.name)}/interaction-limits`;
  const auth = { as: 'engine' as const, repo };
  const now = deps.client.now().getTime();
  const read = async () => {
    const res = await deps.client.request({ method: 'GET', path, auth, signal: ctx.signal });
    // 没有限制时 GitHub 回空对象或空
    if (res.data === null || (typeof res.data === 'object' && Object.keys(res.data as object).length === 0))
      return null;
    const parsed = LimitSchema.safeParse(res.data);
    if (!parsed.success) {
      throw new GitHubError('UNEXPECTED_RESPONSE', `读 ${slug} 的互动限制：返回的形状不认识（没查成）`, {
        retryable: true,
      });
    }
    return parsed.data;
  };

  const current = await read();
  if (current && current.origin === 'user') {
    throw new GitHubError('ACCOUNT_LEVEL_LIMIT', `${slug} 的互动限制是账户级的，只能在账户设置里改`, {
      details: { limit: current.limit },
    });
  }
  const left = current?.expires_at ? Date.parse(current.expires_at) - now : Number.NaN;
  if (
    current?.limit === 'collaborators_only' &&
    Number.isFinite(left) &&
    left > (input.renewWithinDays ?? 30) * DAY
  ) {
    return { action: 'fresh', expiresAt: current.expires_at ?? '' };
  }

  const put = await deps.client.request({
    method: 'PUT',
    path,
    auth,
    body: { limit: 'collaborators_only', expiry: 'six_months' },
    allow: [409],
    signal: ctx.signal,
  });
  if (put.status === 409) {
    throw new GitHubError('ACCOUNT_LEVEL_LIMIT', `${slug} 上有账户级的互动限制，仓级的改不了（409）`);
  }
  // 回读：接口回 200 不等于生效（A8）
  const after = await read();
  const expires = after?.expires_at ? Date.parse(after.expires_at) : Number.NaN;
  if (after?.limit !== 'collaborators_only' || !Number.isFinite(expires) || expires < now + 170 * DAY) {
    throw new GitHubError(
      'READBACK_MISMATCH',
      `续 ${slug} 的互动限制后回读：${after ? `${after.limit}，到期 ${after.expires_at ?? '（空）'}` : '没有限制'}——没生效`,
      { retryable: true },
    );
  }
  deps.log.info('互动限制已续', { repo: slug, expiresAt: after.expires_at });
  return { action: current ? 'renewed' : 'set', expiresAt: after.expires_at ?? '' };
}
