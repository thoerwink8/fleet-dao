// 驾驶舱接口约定（web-api）：任务列表（GET /api/tasks，#1639）。
// 入口是 ../web-api.ts（只有 export *）。状态怎么分组见 ../task-list.ts。
import { z } from 'zod';
import { TASK_LIST_GROUPS } from '../task-list.ts';
import { PageQuery } from './common.ts';
import { TaskStateSchema } from './enums.ts';
import { Cursor, Id, Time } from './internal.ts';

export const TaskListGroupSchema = z.enum(TASK_LIST_GROUPS);

export const TaskListQuery = PageQuery.extend({
  /** 不给 = 全部。 */
  status: TaskListGroupSchema.optional(),
  /** 仓的编号（RepoSchema.id）；不给 = 所有仓。 */
  repoId: Id.optional(),
  /**
   * 搜索：全是数字（可带 #）按 GitHub 单号精确找，同时也找标题里带这串数字的；其余按标题包含（不分大小写）找。
   * 空白的当没给。
   */
  q: z.string().max(200).optional(),
});

/** 累计花费：读到了给美元数；一笔都没读到给 null 并写明原因，不拿 0 顶。部分笔没读到时给读到的合计，并在 note 里写明偏低。 */
export const TaskListCostSchema = z.object({
  usd: z.number().min(0).nullable(),
  note: z.string().optional(),
});

export const TaskListRowSchema = z.object({
  taskId: Id,
  repoId: Id,
  /** owner/name。 */
  repo: z.string(),
  issueNumber: z.number().int().positive(),
  title: z.string(),
  /** 库里的状态；暂停的单 state 仍是 running，看 paused。 */
  state: TaskStateSchema,
  /** 被人暂停了：引擎写的那句「已暂停：被谁暂停、为什么」；没暂停没有这个键。 */
  paused: z.string().optional(),
  /** 筛选分到哪一组。 */
  group: TaskListGroupSchema,
  /** 现在在哪一段（对题、动手、验收、验收还没起、合并）；三段流水推不出的是 null。 */
  segment: z.enum(['scoping', 'doing', 'verifying', 'verify_pending', 'merge']).nullable(),
  /** 用的模型：在跑的那一笔，没有在跑的取最近一笔；一笔流水都没有是 null。 */
  model: z.string().nullable(),
  createdAt: Time,
  /** 最近更新：状态最近一次变化、快照写入、开单三者里最晚的。 */
  updatedAt: Time,
  cost: TaskListCostSchema,
  /** 最近一笔带 PR 的流水上的 PR 号；还没有 PR 是 null。 */
  prNumber: z.number().int().positive().nullable(),
});

const Count = z.number().int().min(0);

export const TaskListResponse = z.object({
  items: z.array(TaskListRowSchema),
  /** 各组的数（只受仓和搜索影响，不受 status 影响），all = 各组之和。 */
  counts: z.object({
    all: Count,
    running: Count,
    queued: Count,
    waiting: Count,
    done: Count,
    failed: Count,
    stopped: Count,
  }),
  nextCursor: Cursor.optional(),
});
