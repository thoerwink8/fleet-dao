// 设置页「仓库」一节的「让 AI 接活」开关（repos.auto_dispatch_since）：每个项目一行读、开关各一个写。
// 写走 Store.setAutoDispatch，和命令行 fleet-api dispatch 同一个入口：开关和操作记录同一事务，已经是要的状态就不改、不记。
// 引擎拉单只认这一列（engine/src/jobs/intake.ts），所以这里点一下，下一轮拉单就照新状态走，不用重启任何东西。

import {
  AUTO_DISPATCH_DISABLE,
  AUTO_DISPATCH_ENABLE,
  RepoDispatchResponse,
  UpdateRepoDispatchRequest,
  UpdateRepoDispatchResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor, IntakeRepo } from './ports.ts';
import type { CockpitEnv } from './session.ts';

const view = (r: IntakeRepo) => ({
  repoId: r.id,
  owner: r.owner,
  name: r.name,
  on: r.autoDispatchSince !== null,
  ...(r.autoDispatchSince === null ? {} : { since: r.autoDispatchSince }),
});

export function registerDispatchRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
): void {
  const { store } = deps;

  app.get(WebRoutes.repoDispatch.path, async (c) => {
    const repos = await store.listRepos();
    // 开关不在 listRepos 里：按名字逐个读（findRepoByName 是接活读开关的那一条）。读不到的（刚被删）不列。
    const rows = await Promise.all(repos.map((r) => store.findRepoByName(r.owner, r.name)));
    return reply(c, RepoDispatchResponse, {
      repos: rows.flatMap((r) => (r ? [view(r)] : [])),
    });
  });

  app.put(WebRoutes.updateRepoDispatch.path, async (c) => {
    const repoId = c.req.param('repoId');
    const body = await readJson(c, UpdateRepoDispatchRequest);
    const repo = await store.getRepo(repoId);
    if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
    const change = await store.setAutoDispatch(
      { repoId: repo.id, on: body.on },
      {
        actor: actorOf(c),
        action: body.on ? AUTO_DISPATCH_ENABLE : AUTO_DISPATCH_DISABLE,
        target: `repo:${repo.id}`,
        reason: body.reason ?? `驾驶舱上点了${body.on ? '开启' : '关闭'}「让 AI 接活」`,
        via: c.get('via'),
        ok: true,
      },
    );
    if (change === 'not_found') throw new ApiError(404, 'repo_not_found', '没有这个项目');
    return reply(c, UpdateRepoDispatchResponse, {
      repoId: repo.id,
      owner: repo.owner,
      name: repo.name,
      on: change.autoDispatchSince !== null,
      ...(change.autoDispatchSince === null ? {} : { since: change.autoDispatchSince }),
      changed: change.changed,
    });
  });
}
