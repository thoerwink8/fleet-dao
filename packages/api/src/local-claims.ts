// 本机领单（决定 0096，shared 的 local-claims.ts）：POST /api/nodes/claims，本机会话领单、续租、结束。
// 挂在 node-report.ts 那个登录门前面的小应用里，和本机会话心跳同一个头（X-Fleet-Node-Token）、同一套钥匙（FLEET_NODE_KEYS）：
// 本机不放机器人凭据，只拿这台环境的通行证。环境编号取对上的那把钥匙，载荷里自报什么都不信。
// 改这里之前必须知道：
// - 写的是 tasks 那一行（executor、lease_until），状态只用引擎认的那几个；判法和事务在 db 的 queries/local-claims.ts。
// - 引擎已经停下等人（stalled / parked）的 claim 一步接手：db 事务里锁行，回调这里的 engineTakeOver 发 taskAbandon（note「本机接手」），
//   发不出去（Temporal 连不上）整个领单回滚、回 409 带原因；工作流已经没了（Gone）当已叫停。引擎还在跑的照旧拒。
// - 不成的（引擎在做、不是本机领着的、仓不归法国管）回 409 / 404 带原因，本机命令照原因停下，不当成登记上了。
// - 没接库（开发、内存版）回 503，不假装登记了。

import { TAKEOVER_NOTE, type TakeOverEngine } from '@fleet-dao/db';
import {
  LOCAL_CLAIMS_PATH,
  type LocalClaimRequest,
  LocalClaimRequestSchema,
  type LocalClaimResponse,
  LocalClaimResponseSchema,
  TASK_SIGNAL_NAMES,
  taskWorkflowId,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from './deps.ts';
import { ApiError, errorBody, readJson, reply } from './http.ts';
import {
  type WorkflowControl,
  WorkflowGoneError,
  WorkflowTargetNotFoundError,
  WorkflowUnavailableError,
} from './ports.ts';

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
    takeOver?: TakeOverEngine | undefined;
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
  /** 接手停下的单要叫停引擎任务用；不给就不接手（停下的单也照旧拒）。 */
  workflows?: WorkflowControl | undefined;
}): LocalClaimsPort {
  return {
    async apply({ nodeId, request, now }) {
      const base = { repo: request.repo, issueNumber: request.issue, nodeId, now };
      const r =
        request.action === 'claim'
          ? await ops.claim({
              ...base,
              title: request.title,
              takeOver: ops.workflows ? engineTakeOver(ops.workflows, request.repo, nodeId) : undefined,
            })
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

/** 接手：给引擎的任务工作流发 taskAbandon（by = node:<环境>，reason = 本机接手）。工作流已经没了当已叫停；连不上、查不清就带原因拒。 */
export function engineTakeOver(workflows: WorkflowControl, repoSlug: string, nodeId: string): TakeOverEngine {
  const [owner = '', name = ''] = repoSlug.split('/');
  return async ({ issueNumber }) => {
    try {
      const workflowId = workflows.runningTaskWorkflow
        ? await workflows.runningTaskWorkflow({ owner, name }, issueNumber)
        : taskWorkflowId({ owner, name }, issueNumber);
      await workflows.signal(workflowId, {
        name: TASK_SIGNAL_NAMES.abandon,
        by: `node:${nodeId}`,
        reason: TAKEOVER_NOTE,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof WorkflowGoneError || err instanceof WorkflowTargetNotFoundError) return { ok: true };
      if (err instanceof WorkflowUnavailableError)
        return { ok: false, why: '工作流服务暂时连不上，叫停信号没发出去' };
      return { ok: false, why: `叫停信号没发出去：${errMessage(err)}` };
    }
  };
}
