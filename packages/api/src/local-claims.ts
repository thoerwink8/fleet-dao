// 本机领单（决定 0096，shared 的 local-claims.ts）：POST /api/nodes/claims，本机会话领单、续租、结束。
// 挂在 node-report.ts 那个登录门前面的小应用里，和本机会话心跳同一个头（X-Fleet-Node-Token）、同一套钥匙（FLEET_NODE_KEYS）：
// 本机不放机器人凭据，只拿这台环境的通行证。环境编号取对上的那把钥匙，载荷里自报什么都不信。
// 改这里之前必须知道：
// - 写的是 tasks 那一行（executor、lease_until），状态只用引擎认的那几个；判法和事务在 db 的 queries/local-claims.ts。
// - 不成的（引擎在做、不是本机领着的、仓不归法国管）回 409 / 404 带原因，本机命令照原因停下，不当成登记上了。
// - 没接库（开发、内存版）回 503，不假装登记了。
import {
  LOCAL_CLAIMS_PATH,
  type LocalClaimRequest,
  LocalClaimRequestSchema,
  type LocalClaimResponse,
  LocalClaimResponseSchema,
} from '@fleet-dao/shared';
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from './deps.ts';
import { ApiError, errorBody, readJson, reply } from './http.ts';

type NodeEnv = { Variables: { nodeId: string } };

/** 本机领单那一口：真装配是 db 的 claimLocalTask / renewLocalTask / finishLocalTask。 */
export interface LocalClaimsPort {
  apply(input: { nodeId: string; request: LocalClaimRequest; now: Date }): Promise<LocalClaimResponse>;
}

export const LOCAL_CLAIMS_NOT_WIRED = '这台后端没接库，本机领单登记不了（开发、内存版）';

const small = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json(errorBody('too_large', '本机领单的请求超过 4 KB，没收'), 413),
});

export function registerLocalClaimsReceiver(
  app: Hono<NodeEnv>,
  deps: Deps,
  authenticate: MiddlewareHandler<NodeEnv>,
): void {
  app.post(LOCAL_CLAIMS_PATH, authenticate, small, async (c) => {
    const port = deps.localClaims;
    if (!port) throw new ApiError(503, 'local_claims_not_wired', LOCAL_CLAIMS_NOT_WIRED);
    const nodeId = c.get('nodeId');
    const request = await readJson(c, LocalClaimRequestSchema);
    const result = await port.apply({ nodeId, request, now: deps.now() });
    if (!result.ok) {
      deps.log.warn('本机领单没成', { nodeId, code: result.code, action: request.action });
      throw new ApiError(result.code === 'unknown_repo' ? 404 : 409, result.code, result.why);
    }
    return reply(c, LocalClaimResponseSchema, result);
  });
}

/** 生产装配：照 action 调 db 的那三下，时刻转成 ISO。 */
export function pgLocalClaims(ops: {
  claim: (i: {
    repo: string;
    issueNumber: number;
    title: string;
    nodeId: string;
    now: Date;
  }) => Promise<Result>;
  renew: (i: { repo: string; issueNumber: number; nodeId: string; now: Date }) => Promise<Result>;
  finish: (i: {
    repo: string;
    issueNumber: number;
    outcome: 'done' | 'failed' | 'released';
    reason?: string | undefined;
    nodeId: string;
    now: Date;
  }) => Promise<Result>;
}): LocalClaimsPort {
  return {
    async apply({ nodeId, request, now }) {
      const base = { repo: request.repo, issueNumber: request.issue, nodeId, now };
      const r =
        request.action === 'claim'
          ? await ops.claim({ ...base, title: request.title })
          : request.action === 'renew'
            ? await ops.renew(base)
            : await ops.finish({ ...base, outcome: request.outcome, reason: request.reason });
      if (!r.ok) return r;
      return { ...r, leaseUntil: r.leaseUntil ? r.leaseUntil.toISOString() : null };
    },
  };
}

type Result =
  | { ok: true; taskId: string; state: string; executor: 'engine' | 'local'; leaseUntil: Date | null }
  | { ok: false; code: 'engine_has_it' | 'not_claimed' | 'unknown_repo'; why: string };
