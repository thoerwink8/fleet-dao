// 驾驶舱接口约定（web-api）：仓与看板。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { HostIdSchema, StageKindSchema, SubtaskStateSchema, TaskStateSchema } from './enums.ts';
import { Id, Time } from './internal.ts';

// —— 仓与看板 ——

export const RepoSchema = z.object({
  id: Id,
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
});
export const ReposResponse = z.object({ repos: z.array(RepoSchema) });

export const ProgressSchema = z.object({
  done: z.number().int().min(0),
  total: z.number().int().min(0),
});

/** 卡片上「此刻在干什么」。前端用 since 实时显示「已 N 分钟」，所以后端不拼进文字。 */
export const ActivitySchema = z.object({
  runId: Id,
  stage: StageKindSchema,
  routeId: Id,
  /** 例如「Opus 5.5」；路由或模型查不到时是「未知模型」。 */
  modelName: z.string(),
  hostId: HostIdSchema.optional(),
  /** true = 还在排队，since 是排队开始的时刻。 */
  queued: z.boolean(),
  since: Time,
  /** 进行中的那一步（fleet plan 里 in_progress 的那条）；没报过就没有。 */
  step: z.string().optional(),
  /** 例如「Opus 5.5 正在写登录页」「Opus 5.5 排队中」。 */
  text: z.string(),
});

export const BoardSubtaskSchema = z.object({
  id: Id,
  index: z.number().int(),
  title: z.string(),
  state: SubtaskStateSchema,
  prNumber: z.number().int().positive().optional(),
  dependsOn: z.array(Id),
  touches: z.array(z.string()),
  /** 当前会话步骤清单的完成数；会话没报过步骤就没有。 */
  progress: ProgressSchema.optional(),
  activity: ActivitySchema.optional(),
});

export const BoardTaskSchema = z.object({
  id: Id,
  issueNumber: z.number().int().positive(),
  title: z.string(),
  state: TaskStateSchema,
  priority: z.number(),
  requestedBy: z.string(),
  createdAt: Time,
  /** 子任务合并数 / 子任务总数。 */
  progress: ProgressSchema,
  /** 需求级的会话（分诊、写需求文档、规划）。 */
  activity: ActivitySchema.optional(),
  subtasks: z.array(BoardSubtaskSchema),
});

export const NowItemSchema = ActivitySchema.extend({
  taskId: Id,
  taskTitle: z.string(),
  subtaskId: Id.optional(),
});

export const BoardResponse = z.object({
  repo: RepoSchema,
  tasks: z.array(BoardTaskSchema),
  /** 「此刻」面板：这个仓里正在跑或排队的会话。 */
  now: z.array(NowItemSchema),
  asOf: Time,
});
