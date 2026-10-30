// 本机把一张单交给法国引擎接（#3739，决定 0122）：POST /api/nodes/dispatch，请求头 X-Fleet-Node-Token，只认机器通行证。
// 取代本机经 ssh 戳法国：法国按和 `fleet-api dispatch-issue`（不带 --force）同一套准入判，过了才起任务工作流，不提供 force。
//
// 回包（路径在 /api 下；出错 body 是 {"error":{"code","message"}}）：
//   200 {"result":"dispatched","text":"…"}  派了；
//   409 {"result":"refused","reasons":[{"reason","why"}],"text":"…"}  准入没过，reasons 列出每一道没过的原因（没派）；
//   503 没查成（库、GitHub、Temporal 读不到，或这台没接派单），error.message 写原因；这时不知道派没派，不当成「没派」也不当成「派了」；
//   401 通行证缺或不对；400 请求体不合约定。
// conventions 的零安装区引不了包，issue-poke.ts 手写请求和解析，packages/conventions/test/issue-poke.test.ts 钉着两边一致。
import { z } from 'zod';

/** 收派单的路径（在 /api 下），和本机会话心跳、领单同一个通行证头。 */
export const NODE_DISPATCH_PATH = '/nodes/dispatch';
/** 完整路径（含 /api）。 */
export const NODE_DISPATCH_FULL_PATH = '/api/nodes/dispatch';

/** 谁让派的：本机会话、帅位会话（指挥官、聊天）、Mirasim。 */
export const NODE_DISPATCH_SOURCE_KINDS = [
  'local-session',
  'harness-commander',
  'harness-chat',
  'mirasim',
] as const;
export type NodeDispatchSourceKind = (typeof NODE_DISPATCH_SOURCE_KINDS)[number];

export const NODE_DISPATCH_REF_MAX = 100;

export const NodeDispatchRequestSchema = z
  .object({
    /** owner/name；写法和 dispatch-issue 命令行一致。 */
    repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/, 'owner/name'),
    issueNumber: z.number().int().min(1).max(999_999_999),
    source: z
      .object({
        kind: z.enum(NODE_DISPATCH_SOURCE_KINDS),
        /** 来源里的指针（本机戳单是单号；会话编号等），只进操作记录。 */
        ref: z.string().min(1).max(NODE_DISPATCH_REF_MAX),
      })
      .strict(),
  })
  .strict();
export type NodeDispatchRequest = z.infer<typeof NodeDispatchRequestSchema>;

export const NodeDispatchReasonSchema = z.object({ reason: z.string(), why: z.string() }).strict();

export const NodeDispatchResponseSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('dispatched'), text: z.string() }).strict(),
  z
    .object({
      result: z.literal('refused'),
      reasons: z.array(NodeDispatchReasonSchema).min(1),
      text: z.string(),
    })
    .strict(),
]);
export type NodeDispatchResponse = z.infer<typeof NodeDispatchResponseSchema>;

/** 操作记录的动作名，target 是 `issue:<owner>/<name>#<号>`。 */
export const NODE_DISPATCH_AUDIT_ACTION = 'issue.dispatch_request';
