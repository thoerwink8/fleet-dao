import { PublicCiPolicyRoute, policyId } from '@fleet-dao/shared';
import { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError } from './http.ts';

/** 只公开精确 GET，不认 Cookie/Bearer，也不提供 refresh/写策略。 */
export function ciPolicyPublicRoutes(deps: Deps): Hono {
  const app = new Hono();
  app.get(PublicCiPolicyRoute.path, async (c) => {
    c.header('Cache-Control', 'no-store');
    const value = c.req.param('githubId');
    const id = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    if (!policyId(id)) throw new ApiError(404, 'policy_unavailable', '没有可用的公开策略');
    const url = new URL(c.req.url);
    if (url.search) {
      const pr = Number(url.searchParams.get('pr'));
      const head = url.searchParams.get('head') ?? '';
      if (!policyId(pr) || !/^[a-f0-9]{40}$/.test(head))
        throw new ApiError(400, 'bad_policy_query', '策略查询参数不符合协议');
      if (url.search !== `?pr=${pr}&head=${head}`)
        throw new ApiError(400, 'bad_policy_query', '策略查询参数不符合协议');
    }
    if (!deps.ciPolicyBridge) throw new ApiError(503, 'policy_not_connected', '真实策略桥未装配');
    return c.json(await deps.ciPolicyBridge.read(id));
  });
  return app;
}
