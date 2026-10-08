// 驾驶舱接口约定（web-api）：每个项目的「让 AI 接活」开关（repos.auto_dispatch_since）。
// 入口是 ../web-api.ts（只有 export *）。写入口是后端的 Store.setAutoDispatch（和命令行 fleet-api dispatch 同一个），
// 改了和操作记录同一事务。

import { z } from 'zod';
import { GroomResultSchema } from '../groom.ts';
import { Id, Time } from './internal.ts';

/** 操作记录里开、关这两件事的名字；target 是 repo:<仓的编号>。命令行和驾驶舱用同一对。 */
export const AUTO_DISPATCH_ENABLE = 'repo.auto_dispatch.enable';
export const AUTO_DISPATCH_DISABLE = 'repo.auto_dispatch.disable';

/** 一个项目一行：现在开还是关、什么时候开的（关着没有）。 */
export const RepoDispatchSchema = z.object({
  repoId: Id,
  owner: z.string(),
  name: z.string(),
  on: z.boolean(),
  /** 开着才有：打开的时刻。 */
  since: Time.optional(),
});
export const RepoDispatchResponse = z.object({ repos: z.array(RepoDispatchSchema) });

/** reason 可选，写进操作记录。 */
export const UpdateRepoDispatchRequest = z.object({
  on: z.boolean(),
  reason: z.string().max(500).optional(),
});

/** changed=false：本来就是要的状态，没改、没记操作记录（开着再点开不重设时刻）。 */
export const UpdateRepoDispatchResponse = RepoDispatchSchema.extend({ changed: z.boolean() });

// —— 临时指挥官整理待办（母单 #1335 第 3 片，#1338）：设置页仓库一节的「让指挥官整理」按钮要的两个口 ——
// 点一下 = 记一条操作记录 groom.request（和命令行 fleet-api groom、引擎拉单一轮自己叫是同一个入口、同一把锁），引擎接手整理。
// 一次整理走到哪不另存，读的时候从操作记录现算（../groom.ts 的 foldGroomRequests）。

export const GroomRequestViewSchema = z.object({
  requestId: Id,
  repo: z.string(),
  source: z.enum(['auto', 'http', 'cli']),
  requestedAt: Time,
  by: z.string(),
  state: z.enum(['queued', 'running', 'done', 'failed', 'expired']),
  startedAt: Time.optional(),
  finishedAt: Time.optional(),
  /** 没做成 / 作废的原因。 */
  why: z.string().optional(),
  /** 做成了什么；没做成但已经做了一部分也给。 */
  result: GroomResultSchema.optional(),
});

export const GroomQuotaSchema = z.object({
  /** 这个仓最近 24 小时接手了几次、还剩几次、每天最多几次。 */
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  max: z.number().int().positive(),
  lastStartedAt: Time.nullable(),
});

/** 「让指挥官整理」按钮要的现状：今日剩余次数、最近几次结果、有没有一次在做（含别的仓的：锁是全局的）。 */
export const GroomStatusResponse = z.object({
  asOf: Time,
  repoId: Id,
  repo: z.string(),
  quota: GroomQuotaSchema,
  /** 有一次整理在排队或在做（任何仓）：按钮此刻点了会被拒。 */
  busy: z.boolean(),
  /** 此仓最近几次（新的在前，最多 5 条）。 */
  recent: z.array(GroomRequestViewSchema).max(5),
  /** 认不出的操作记录有几条（不拿空列表冒充没点过）。 */
  unreadable: z.number().int().nonnegative(),
});

/** reason 可选，写进操作记录。 */
export const GroomNowRequest = z.object({ reason: z.string().max(500).optional() });
export const GroomNowResponse = z.object({
  request: GroomRequestViewSchema,
  /** 这一次接了以后今天还剩几次。 */
  remainingAfter: z.number().int().nonnegative(),
});
