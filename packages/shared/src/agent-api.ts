// fleet 命令（跑在 AI 会话里）⇄ 驾驶舱后端 的接口约定。命令这边（packages/cli）和后端那边（packages/api）都按这份实现。
// 认证：请求头 `Authorization: Bearer <FLEET_TOKEN>`；令牌只对一个任务的一次会话有效，过期即失效，不能合并、不能改调度台。
import { z } from 'zod';

export const AGENT_API_PREFIX = '/agent/v1';

export const StepSchema = z.object({
  title: z.string().min(1).max(200),
  state: z.enum(['pending', 'in_progress', 'done']),
});

/** 照 Codex 的做法：一张步骤清单，同一时间最多一步在进行。 */
export const PlanRequest = z
  .object({ steps: z.array(StepSchema).min(1).max(30) })
  .refine((v) => v.steps.filter((s) => s.state === 'in_progress').length <= 1, {
    message: '同一时间只能有一步在进行',
  });

/** 一句白话进度，例如「正在写验证码过期的测试」。 */
export const SayRequest = z.object({ text: z.string().min(1).max(500) });

/** 问创始人。blocking=true 时命令会等回答（有上限），等不到就返回 pending，AI 按写明的假设继续并在结果里注明。 */
export const AskRequest = z.object({
  question: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(200)).max(4).optional(),
  blocking: z.boolean().default(true),
});
export const AskResponse = z.object({
  askId: z.string(),
  status: z.enum(['answered', 'pending']),
  answer: z.string().optional(),
});

/** 交活。后端会核实（PR 是否存在、测试是否真跑过），不是说了就算。 */
export const DoneRequest = z.object({
  summary: z.string().min(1).max(4000),
  prNumber: z.number().int().positive().optional(),
  testsPassed: z.boolean(),
});

export const BlockedRequest = z.object({
  reason: z.string().min(1).max(4000),
  needs: z.enum(['human', 'info', 'access', 'other']),
});

/** 看自己的任务：需求、做完标准、要改哪里、当前步骤。 */
export const TaskResponse = z.object({
  taskId: z.string(),
  subtaskId: z.string().optional(),
  repo: z.string(),
  branch: z.string(),
  specDir: z.string().optional(),
  request: z.string(),
  acceptance: z.array(z.string()),
  touches: z.array(z.string()),
  plan: z.array(StepSchema),
});

/** 翻历史需求：按改动位置和关键词找做过的需求与结果。 */
export const HistoryRequest = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(5),
});
export const HistoryResponse = z.object({
  items: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      specDir: z.string().optional(),
      resultSummary: z.string().optional(),
      mergedAt: z.string().optional(),
    }),
  ),
});

export const AgentRoutes = {
  task: { method: 'GET', path: '/task', response: TaskResponse },
  plan: { method: 'POST', path: '/plan', request: PlanRequest },
  say: { method: 'POST', path: '/say', request: SayRequest },
  ask: { method: 'POST', path: '/ask', request: AskRequest, response: AskResponse },
  history: { method: 'POST', path: '/history', request: HistoryRequest, response: HistoryResponse },
  done: { method: 'POST', path: '/done', request: DoneRequest },
  blocked: { method: 'POST', path: '/blocked', request: BlockedRequest },
} as const;
