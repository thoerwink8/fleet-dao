// 本机领单（决定 0096，shared 的 local-claims.ts）：POST /api/nodes/claims，本机会话领单、续租、结束；GET 同一路径读所有仓本机领着的未到期租约（#3388，协议在 shared 的 node-claims.ts）。
// 挂在 node-report.ts 那个登录门前面的小应用里，和本机会话心跳同一个头（X-Fleet-Node-Token）、同一套钥匙（FLEET_NODE_KEYS）：
// 本机不放机器人凭据，只拿这台环境的通行证。环境编号取对上的那把钥匙，载荷里自报什么都不信。
// 改这里之前必须知道：
// - 写的是 tasks 那一行（executor、lease_until），状态只用引擎认的那几个；判法和事务在 db 的 queries/local-claims.ts。
// - 引擎已经停下等人（stalled / parked）的 claim 一步接手：db 事务里锁行，回调这里的 engineTakeOver 发 taskAbandon（note「本机接手」），
//   发不出去（Temporal 连不上）整个领单回滚、回 409 带原因；工作流已经没了（Gone）当已叫停。引擎还在跑的照旧拒。
// - 不成的（引擎在做、不是本机领着的、仓不归法国管）回 409 / 404 带原因，本机命令照原因停下，不当成登记上了。
// - 没接库（开发、内存版）回 503，不假装登记了。

import {
  type ReadWorkflow,
  type SignalRun,
  TAKEOVER_NOTE,
  type TakeOverEngine,
  type TakeoverPr,
} from '@fleet-dao/db';
import {
  LOCAL_CLAIMS_PATH,
  type LocalClaimRefusal,
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
import { z } from 'zod';
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
  /** 所有仓里 executor = local 且租约未到期的行（GET 读口）；读不到照抛。 */
  list(input: {
    now: Date;
  }): Promise<{ repo: string; issue: number; claimedBy: string; leaseUntil: string }[]>;
}

export const LOCAL_CLAIMS_NOT_WIRED = '这台后端没接库，本机领单登记不了（开发、内存版）';

const small = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json(errorBody('too_large', '本机领单的请求超过 4 KB，没收'), 413),
});

/** GET 的回包：只这四个字段（协议在 shared 的 node-claims.ts）。 */
const LocalClaimsListSchema = z
  .object({
    claims: z.array(
      z
        .object({ repo: z.string(), issue: z.number().int(), claimedBy: z.string(), leaseUntil: z.string() })
        .strict(),
    ),
  })
  .strict();

export const LOCAL_CLAIMS_UNREADABLE = '读不到本机租约（库读失败），不拿空列表冒充「没人领着」';

export function registerLocalClaimsReceiver(
  app: Hono<NodeEnv>,
  deps: Deps,
  authenticate: MiddlewareHandler<NodeEnv>,
): void {
  // 读口（#3388）：和 POST 同一个认人（只认机器通行证）；所有仓里本机领着、租约没到期的单，让别的机器领单前能看到。
  app.get(LOCAL_CLAIMS_PATH, authenticate, async (c) => {
    const port = deps.localClaims;
    if (!port) throw new ApiError(503, 'local_claims_not_wired', LOCAL_CLAIMS_NOT_WIRED);
    let claims: Awaited<ReturnType<LocalClaimsPort['list']>>;
    try {
      claims = await port.list({ now: deps.now() });
    } catch (err) {
      deps.log.warn('本机租约读不到', { nodeId: c.get('nodeId'), error: errMessage(err) });
      throw new ApiError(503, 'local_claims_unreadable', LOCAL_CLAIMS_UNREADABLE);
    }
    // 明确只投影这四个字段：端口多给什么都不外漏
    return reply(c, LocalClaimsListSchema, {
      claims: claims.map((r) => ({
        repo: r.repo,
        issue: r.issue,
        claimedBy: r.claimedBy,
        leaseUntil: r.leaseUntil,
      })),
    });
  });

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
    takeoverPr?: TakeoverPr | undefined;
  }) => Promise<Result>;
  /** 受管接手的交接确认：真装配是 db 的 confirmLocalTakeover。不给就确认不了（接手也不开：见 apply）。 */
  confirmTakeover?:
    | ((i: {
        repo: string;
        issueNumber: number;
        nodeId: string;
        now: Date;
        pr: number;
        head: string;
        readWorkflow: ReadWorkflow;
      }) => Promise<Result>)
    | undefined;
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
  /** 读口：真装配是 db 的 listLocalClaims。 */
  list: (now: Date) => Promise<{ repo: string; issue: number; claimedBy: string; leaseUntil: Date }[]>;
}): LocalClaimsPort {
  return {
    async list({ now }) {
      return (await ops.list(now)).map((r) => ({ ...r, leaseUntil: r.leaseUntil.toISOString() }));
    },
    async apply({ nodeId, request, now }) {
      const base = { repo: request.repo, issueNumber: request.issue, nodeId, now };
      const noTakeover = {
        ok: false,
        code: 'takeover_refused',
        why: '这台后端没接工作流读取或交接确认，不开受管接手',
      } as const;
      if (request.action === 'takeover_confirm') {
        if (!ops.workflows || !ops.confirmTakeover) return noTakeover;
        const r = await ops.confirmTakeover({
          ...base,
          pr: request.takeoverPr.pr,
          head: request.takeoverPr.head,
          readWorkflow: readTaskWorkflow(ops.workflows, request.repo),
        });
        return r.ok ? { ...r, leaseUntil: r.leaseUntil ? r.leaseUntil.toISOString() : null } : r;
      }
      if (request.action === 'claim' && request.takeoverPr && !(ops.workflows && ops.confirmTakeover))
        return noTakeover;
      const r =
        request.action === 'claim'
          ? await ops.claim({
              ...base,
              title: request.title,
              takeOver: ops.workflows ? engineTakeOver(ops.workflows, request.repo, nodeId) : undefined,
              ...(request.takeoverPr && ops.workflows
                ? {
                    takeoverPr: {
                      ...request.takeoverPr,
                      readWorkflow: readTaskWorkflow(ops.workflows, request.repo),
                      signalRun: signalTaskRun(ops.workflows, nodeId),
                    },
                  }
                : {}),
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
  | { ok: false; code: LocalClaimRefusal; why: string };

/** 精确读这张单现在的任务工作流（编号、run、是否还在跑）。读不到、没有精确读能力都明确失败，不猜最新 run。 */
export function readTaskWorkflow(workflows: WorkflowControl, repoSlug: string): ReadWorkflow {
  const [owner = '', name = ''] = repoSlug.split('/');
  return async ({ issueNumber }) => {
    if (!workflows.taskWorkflowExecution) return { ok: false, why: '没有精确工作流 run 现读能力' };
    try {
      const workflowId = workflows.runningTaskWorkflow
        ? await workflows.runningTaskWorkflow({ owner, name }, issueNumber)
        : taskWorkflowId({ owner, name }, issueNumber);
      const e = await workflows.taskWorkflowExecution(workflowId);
      if (!e.workflowId || !e.runId) return { ok: false, why: '工作流身份不完整' };
      return { ok: true, workflowId: e.workflowId, runId: e.runId, running: e.running };
    } catch (err) {
      return { ok: false, why: errMessage(err) };
    }
  };
}

/** 只对刚读到的那个精确 run 发 taskAbandon（本机接手）；那个 run 已经没了当已结束，连不上、别的错带原因拒。 */
export function signalTaskRun(workflows: WorkflowControl, nodeId: string): SignalRun {
  return async (_task, run) => {
    try {
      await workflows.signal(
        run.workflowId,
        { name: TASK_SIGNAL_NAMES.abandon, by: `node:${nodeId}`, reason: TAKEOVER_NOTE },
        run.runId,
      );
      return { ok: true };
    } catch (err) {
      if (err instanceof WorkflowGoneError || err instanceof WorkflowTargetNotFoundError) return { ok: true };
      if (err instanceof WorkflowUnavailableError)
        return { ok: false, why: '工作流服务暂时连不上，叫停信号没发出去' };
      return { ok: false, why: `叫停信号没发出去：${errMessage(err)}` };
    }
  };
}

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
