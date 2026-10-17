// 驾驶舱接口约定（web-api）：任务列表（GET /api/tasks，#1639）。
// 入口是 ../web-api.ts（只有 export *）。状态怎么分组见 ../task-list.ts。
import { z } from 'zod';
import { FLOW_MODES } from '../flow-mode.ts';
import { TASK_LIST_GROUPS } from '../task-list.ts';
import type { ListedTaskCost } from '../usage.ts';
import { PageQuery } from './common.ts';
import { TaskExecutorSchema, TaskStateSchema } from './enums.ts';
import { Cursor, Id, type Same, Time } from './internal.ts';

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

/**
 * 累计花费。actual / usd 是执行体报的实付（一笔都没报是 null，不当成 0）。
 * estimated 是没报实付时按目录单价折的「按 API 价折算」（没估成是 null，不当成 0）。
 * 订阅渠道看 estimated，不看 0。没有单价的记 noPrice，页面写「没有单价」。
 */
export const TaskListCostSchema = z.object({
  actual: z.number().min(0).nullable(),
  estimated: z.number().min(0).nullable(),
  /** 和 actual 同一个数：只认这一栏的老页面还能读。 */
  usd: z.number().min(0).nullable(),
  /** 结束了的三段笔数。 */
  segments: z.number().int().min(0),
  /** 四样 token 都没读到的段数。 */
  unreadSegments: z.number().int().min(0),
  /** 目录里没有单价的段数。 */
  noPrice: z.number().int().min(0),
  note: z.string().optional(),
});
/** 编译期闸：和 usage.ts 的 taskListCost 一字不差。 */
export const LIST_COST_MATCHES: Same<z.infer<typeof TaskListCostSchema>, ListedTaskCost> = true;

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
  /** 谁在做：engine = 法国引擎，local = 本机领的（决定 0096，tasks.executor）。老后端、老环境推来的快照没有这个键，当引擎。 */
  executor: TaskExecutorSchema.optional(),
  /** 本机领的单：领它的环境编号（通行证认出的，如 founder-pc；tasks.claimed_by）。引擎的单没有这个键。 */
  claimedBy: z.string().optional(),
  /** 本机领的单：租约到期的时刻（tasks.lease_until）；到点没续就退回法国队列。引擎的单没有这个键。 */
  leaseUntil: Time.optional(),
  /**
   * 这张单实际走的流程（tasks.flow_mode，#2828）：three 三段、full 全程。
   * 还没分组的老单没有这个键。页面不补、不猜。
   */
  flowMode: z.enum(FLOW_MODES).optional(),
  /**
   * 不合格、实际退回三段的原因（分组记录 source = ineligible，且不是「开关就是三步法」）。
   * 没有这个键就不是退回。老后端没有，页面不猜。
   */
  flowFallback: z.string().min(1).optional(),
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
  /** 这张单是驾驶舱哪条需求开出来的（「来自需求 N」）；不是提需求开的没有这个键。页面显示归 D 片。 */
  requestSeq: z.number().int().positive().optional(),
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
  /**
   * 「来自需求 N」没查成的原因（需求表读不到）：有它时 items 里一律没有 requestSeq，页面写出这句，
   * 不能当成「这些单都不是提需求开的」。这台后端没接需求表（开发环境）时没有这个键，也没有 requestSeq。
   */
  requestSeqUnavailable: z.string().optional(),
});
