// 驾驶舱接口约定（web-api）：每个项目的「让 AI 接活」开关（repos.auto_dispatch_since）。
// 入口是 ../web-api.ts（只有 export *）。写入口是后端的 Store.setAutoDispatch（和命令行 fleet-api dispatch 同一个），
// 改了和操作记录同一事务。

import { z } from 'zod';
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
