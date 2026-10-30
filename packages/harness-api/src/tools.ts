// 工具注册表：每个工具声明哪些角色能调、会不会引起外部写。注册是按令牌的角色逐请求做的——
// 角色不够的工具根本不注册（列表里没有、调了就是「没这个工具」）；影子模式下会引起外部写的工具也不注册。
import { randomUUID } from 'node:crypto';
import { type SessionRole, SpawnWorkerInput } from '@fleet-dao/harness-contract';
import type { Db } from '@fleet-dao/harness-store';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { appendToSession, readSessionByTask, readSessionByType } from './events.ts';

export interface ToolContext {
  db: Db;
  sessionId: string;
  role: SessionRole;
}

export interface ToolEntry {
  name: string;
  roles: readonly SessionRole[];
  /** 会引起外部写（派进程、停进程……）；影子模式不注册。这一片的处理器只记事件，标记留给后面的片接外部动作。 */
  externalWrite: boolean;
  register(server: McpServer, ctx: ToolContext): void;
}

function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  roles: readonly SessionRole[];
  externalWrite: boolean;
  input: S;
  handler(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}): ToolEntry {
  return {
    name: def.name,
    roles: def.roles,
    externalWrite: def.externalWrite,
    register(server, ctx) {
      const callback = async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
        // 注册时已按角色筛过；这里再核一次，防止以后有人绕过注册表直接调。
        if (!def.roles.includes(ctx.role)) {
          return {
            isError: true,
            content: [{ type: 'text', text: `角色 ${ctx.role} 不能调 ${def.name}` }],
          };
        }
        const result = await def.handler(ctx, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      };
      // SDK 的泛型回调类型和本仓 exactOptionalPropertyTypes 对不上；参数形状由 inputSchema 在 SDK 里校验过，这里收口。
      server.registerTool(
        def.name,
        { description: def.description, inputSchema: def.input },
        callback as never,
      );
    },
  };
}

const COMMANDER = ['commander'] as const;
const WORKER = ['worker'] as const;

export const TOOLS: readonly ToolEntry[] = [
  defineTool({
    name: 'spawn_worker',
    description: '派一个工人去做一件事。六项都必填：task、expected、must_do、must_not、context、stop_when。',
    roles: COMMANDER,
    externalWrite: true,
    input: SpawnWorkerInput,
    async handler(ctx, args) {
      const taskId = randomUUID();
      const ev = await appendToSession(ctx.db, ctx.sessionId, 'worker.spawn.requested', { taskId, ...args });
      return { taskId, eventId: ev.id };
    },
  }),
  defineTool({
    name: 'list_tasks',
    description: '列出本会话派过的工人任务，按派出顺序一页一页读（after_seq 是游标）。',
    roles: COMMANDER,
    externalWrite: false,
    input: { after_seq: z.number().int().min(0).default(0) },
    async handler(ctx, args) {
      const rows = await readSessionByType(ctx.db, ctx.sessionId, 'worker.spawn.requested', args.after_seq);
      return {
        tasks: rows.map((r) => ({ taskId: r.payload.taskId, task: r.payload.task, seq: r.seq })),
        next_after_seq: rows.at(-1)?.seq ?? args.after_seq,
      };
    },
  }),
  defineTool({
    name: 'get_task',
    description: '查一个任务：派工单和后来对它的操作。',
    roles: COMMANDER,
    externalWrite: false,
    input: { task_id: z.string().min(1) },
    async handler(ctx, args) {
      const rows = await readSessionByTask(ctx.db, ctx.sessionId, args.task_id);
      if (rows.length === 0) return { found: false };
      return { found: true, events: rows.map((r) => ({ seq: r.seq, type: r.type, payload: r.payload })) };
    },
  }),
  defineTool({
    name: 'stop_worker',
    description: '叫停一个已派出的任务。',
    roles: COMMANDER,
    externalWrite: true,
    input: { task_id: z.string().min(1), reason: z.string().min(1) },
    async handler(ctx, args) {
      const known = (await readSessionByTask(ctx.db, ctx.sessionId, args.task_id)).some(
        (r) => r.type === 'worker.spawn.requested',
      );
      if (!known) return { stopped: false, why: '本会话没有这个任务' };
      const ev = await appendToSession(ctx.db, ctx.sessionId, 'worker.stop.requested', {
        taskId: args.task_id,
        reason: args.reason,
      });
      return { stopped: true, eventId: ev.id };
    },
  }),
  defineTool({
    name: 'report_progress',
    description: '工人报一条进度。',
    roles: WORKER,
    externalWrite: false,
    input: { summary: z.string().min(1), percent: z.number().min(0).max(100).optional() },
    async handler(ctx, args) {
      const ev = await appendToSession(ctx.db, ctx.sessionId, 'worker.progress.reported', args);
      return { eventId: ev.id };
    },
  }),
  defineTool({
    name: 'submit_result',
    description: '工人交结果，交一次。',
    roles: WORKER,
    externalWrite: false,
    input: {
      status: z.enum(['done', 'failed', 'blocked']),
      summary: z.string().min(1),
      evidence: z.string().optional(),
    },
    async handler(ctx, args) {
      const ev = await appendToSession(ctx.db, ctx.sessionId, 'worker.result.submitted', args);
      return { eventId: ev.id };
    },
  }),
];

/** 这个角色在当前模式下能用的工具。 */
export function toolsFor(role: SessionRole, shadow: boolean): ToolEntry[] {
  return TOOLS.filter((t) => t.roles.includes(role) && !(shadow && t.externalWrite));
}
