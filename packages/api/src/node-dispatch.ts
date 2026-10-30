// 本机把单交给法国引擎接（#3739，决定 0122，shared 的 node-dispatch.ts）：POST /api/nodes/dispatch。
// 挂在 node-report.ts 那个登录门前面的小应用里，和本机会话心跳、领单同一个头（X-Fleet-Node-Token）、同一套钥匙：环境编号取对上的那把，载荷里自报什么都不信。
// 改这里之前必须知道：
// - 准入不在这里另写：派单函数就是看门狗修复用的 repair-dispatch.ts 的 repairDispatcher，它起的就是 fleet-api dispatch-issue 的本体
//   （engine/src/bin/dispatch-issue.ts，不带 --force），所以准入和命令行完全同一套；这里不提供 force，请求体也没有这个字段。
// - 结果三种，互不冒充：派了（200）；准入没过（409，reasons 列出每一道）；没查成（503，不知道派没派）。输出认不出的也走 503，不猜。
// - 每次请求（过了通行证和请求体校验的）写一条操作记录 issue.dispatch_request，来源、节点编号、结果在 after。
//   派了而记录写不进，要明说（502），不吞；没派的记录写不进只记日志，照常回真结果。
import {
  NODE_DISPATCH_AUDIT_ACTION,
  NODE_DISPATCH_PATH,
  NodeDispatchRequestSchema,
  type NodeDispatchResponse,
  NodeDispatchResponseSchema,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from './deps.ts';
import { ApiError, errorBody, readJson, reply } from './http.ts';

type NodeEnv = { Variables: { nodeId: string } };

/** 派一张单：ok 是派了；没派的 text 以「没派：」开头（dispatch-issue 的输出）。认不出的结果抛错。 */
export type NodeDispatchFn = (
  repo: { owner: string; name: string },
  issueNumber: number,
  operator: string,
) => Promise<{ ok: boolean; text: string }>;

export const NODE_DISPATCH_NOT_WIRED = '这台后端没接派单（开发、内存版），派不了';

const small = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json(errorBody('too_large', '派单请求超过 4 KB，没收'), 413),
});

/** 从 dispatch-issue 的「没派」输出里认出每一道没过的原因（行首两个空格 + 原因码 + 全角冒号 + 说明）。 */
export function parseRefusalReasons(text: string): { reason: string; why: string }[] {
  const out: { reason: string; why: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+([a-z][a-z0-9_]*)：(.+)$/.exec(line);
    if (m?.[1] && m[2]) out.push({ reason: m[1], why: m[2].trim() });
  }
  return out;
}

/** 写进引擎操作记录的执行者：带上节点和来源，截到 64 字（dispatch-issue 只收这么长）。 */
const operatorOf = (nodeId: string, kind: string, ref: string): string =>
  `node:${nodeId} ${kind}:${ref}`
    .replace(/[\r\n\0]/g, ' ')
    .trim()
    .slice(0, 64);

export function registerNodeDispatchReceiver(
  app: Hono<NodeEnv>,
  deps: Deps,
  authenticate: MiddlewareHandler<NodeEnv>,
): void {
  app.post(NODE_DISPATCH_PATH, authenticate, small, async (c) => {
    const dispatch = deps.nodeDispatch;
    if (!dispatch) throw new ApiError(503, 'node_dispatch_not_wired', NODE_DISPATCH_NOT_WIRED);
    const nodeId = c.get('nodeId');
    const req = await readJson(c, NodeDispatchRequestSchema);
    const [owner = '', name = ''] = req.repo.split('/');
    const target = `issue:${req.repo}#${req.issueNumber}`;
    const base = { source: req.source, nodeId };
    const entry = {
      actor: { kind: 'agent', id: nodeId },
      action: NODE_DISPATCH_AUDIT_ACTION,
      target,
      via: 'agent',
    } as const;

    let outcome: NodeDispatchResponse | { result: 'unavailable'; error: string };
    try {
      const got = await dispatch(
        { owner, name },
        req.issueNumber,
        operatorOf(nodeId, req.source.kind, req.source.ref),
      );
      if (got.ok) outcome = { result: 'dispatched', text: got.text };
      else {
        const reasons = parseRefusalReasons(got.text);
        outcome =
          reasons.length > 0
            ? { result: 'refused', reasons, text: got.text }
            : { result: 'unavailable', error: `认不出准入结果：${got.text.slice(0, 300)}` };
      }
    } catch (err) {
      outcome = { result: 'unavailable', error: errMessage(err).slice(0, 500) };
    }

    if (outcome.result === 'unavailable') {
      deps.log.warn('本机交单没查成', { nodeId, target, error: outcome.error });
      await deps.store
        .appendAudit({ ...entry, after: { ...base, result: 'unavailable' }, ok: false, error: outcome.error })
        .catch((auditErr: unknown) =>
          deps.log.error('本机交单没查成，这条记录也没写进去', { target, auditError: errMessage(auditErr) }),
        );
      throw new ApiError(503, 'dispatch_unavailable', `没查成，不知道派没派：${outcome.error}`);
    }

    const after =
      outcome.result === 'refused'
        ? { ...base, result: 'refused', reasons: outcome.reasons.map((r) => r.reason) }
        : { ...base, result: 'dispatched' };
    try {
      await deps.store.appendAudit({ ...entry, after, ok: true });
    } catch (auditErr) {
      if (outcome.result === 'dispatched') {
        deps.log.error('已派出去了，但操作记录写不进', { target, auditError: errMessage(auditErr) });
        throw new ApiError(
          502,
          'dispatched_audit_failed',
          `${target} 已经派出去了，但操作记录写不进（${errMessage(auditErr)}）：请手工核对这张单的任务`,
        );
      }
      deps.log.error('没派的这条记录写不进', { target, auditError: errMessage(auditErr) });
    }
    return reply(c, NodeDispatchResponseSchema, outcome, outcome.result === 'refused' ? 409 : 200);
  });
}
