// 设置页「仓库」一节的「导入仓库」：列出两个机器人已经装上的仓，把仓接进或移出驾驶舱。
//
// 列仓走安装令牌 GET /installation/repositories（github 的 listInstallationRepositories），不走用户 OAuth。
// 装 App、连本人 GitHub 不在这里：接入走本机 pnpm project add。接进/移出只动我们自己的 repos 表。

import type { InstallationListedRepo } from '@fleet-dao/github';
import {
  githubInstallLinks,
  type ImportableRepo,
  ImportableReposResponse,
  ImportRepoRequest,
  ImportRepoResponse,
  REPO_IMPORT_ADD,
  REPO_IMPORT_REMOVE,
  RemoveRepoResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor } from './ports.ts';
import type { CockpitEnv } from './session.ts';

const NOT_WIRED = '这台后端没接上 GitHub（机器人凭据没读到），导入列表读不了';

function toImportable(
  repo: InstallationListedRepo,
  installed: { agent: boolean; engine: boolean },
  cockpit: { inCockpit: boolean; reposId?: string | undefined },
): ImportableRepo {
  return {
    githubId: repo.id,
    owner: repo.owner,
    name: repo.name,
    fullName: repo.fullName,
    private: repo.private,
    defaultBranch: repo.defaultBranch,
    ownerType: repo.ownerType,
    archived: repo.archived,
    empty: repo.empty,
    agentInstalled: installed.agent,
    engineInstalled: installed.engine,
    fullyInstalled: installed.agent && installed.engine,
    inCockpit: cockpit.inCockpit,
    ...(cockpit.reposId === undefined ? {} : { reposId: cockpit.reposId }),
  };
}

interface Merged {
  repo: InstallationListedRepo;
  agent: boolean;
  engine: boolean;
}

/** 两个机器人各列一遍，按 GitHub 仓号并成一行。一边失败就整次失败，不拿缺了一边的表冒充全的。 */
async function mergedInstallations(deps: Deps): Promise<Merged[]> {
  const source = deps.installationRepos;
  if (!source) throw new ApiError(503, 'github_unavailable', NOT_WIRED);
  const [agent, engine] = await Promise.all([source.list('agent'), source.list('engine')]);
  const byId = new Map<number, Merged>();
  for (const repo of agent) byId.set(repo.id, { repo, agent: true, engine: false });
  for (const repo of engine) {
    const hit = byId.get(repo.id);
    if (hit) hit.engine = true;
    else byId.set(repo.id, { repo, agent: false, engine: true });
  }
  return [...byId.values()];
}

export function registerRepoImportRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
): void {
  const { store } = deps;

  app.get(WebRoutes.importableRepos.path, async (c) => {
    if (!deps.installationRepos) {
      return reply(c, ImportableReposResponse, { repos: [], reason: NOT_WIRED });
    }
    let rows: Merged[];
    try {
      rows = await mergedInstallations(deps);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      return reply(c, ImportableReposResponse, {
        repos: [],
        reason: `没能列出两个机器人已经装上的仓：${errMessage(err)}`,
      });
    }
    const cockpitRows = await store.listRepos();
    const cockpitByName = new Map(cockpitRows.map((r) => [`${r.owner}/${r.name}`.toLowerCase(), r.id]));
    const repos = rows.map(({ repo, agent, engine }) => {
      const reposId = cockpitByName.get(repo.fullName.toLowerCase());
      return toImportable(
        repo,
        { agent, engine },
        {
          inCockpit: reposId !== undefined,
          ...(reposId === undefined ? {} : { reposId }),
        },
      );
    });
    return reply(c, ImportableReposResponse, { repos });
  });

  app.post(WebRoutes.importRepo.path, async (c) => {
    const body = await readJson(c, ImportRepoRequest);
    const rows = await mergedInstallations(deps);
    const hit = rows.find((r) => r.repo.id === body.githubId);
    if (!hit) throw new ApiError(404, 'repo_not_visible', '这个仓不在两个机器人已经装上的范围里');
    const repo = hit.repo;
    if (repo.empty) throw new ApiError(400, 'repo_empty', '空仓：没有代码，接进来也没有活可派');
    if (repo.archived) throw new ApiError(400, 'repo_archived', '已归档：不再改动');

    const result = await store.addRepo(
      {
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        testCommand: 'pnpm check',
      },
      {
        actor: actorOf(c),
        action: REPO_IMPORT_ADD,
        target: `repo:${repo.fullName.toLowerCase()}`,
        reason: `从驾驶舱导入 ${repo.fullName}`,
        via: c.get('via'),
        ok: true,
      },
    );
    const missing = (['agent', 'engine'] as const).filter((role) => !hit[role]);
    return reply(
      c,
      ImportRepoResponse,
      {
        repoId: result.repo.id,
        owner: result.repo.owner,
        name: result.repo.name,
        created: result.created,
        appsInstalled: missing.length === 0,
        agentInstalled: hit.agent,
        engineInstalled: hit.engine,
        installLinks:
          missing.length === 0
            ? []
            : githubInstallLinks({ owner: repo.owner, ownerType: repo.ownerType, missing }),
      },
      result.created ? 201 : 200,
    );
  });

  app.delete(WebRoutes.removeRepo.path, async (c) => {
    const repoId = c.req.param('repoId');
    const repo = await store.getRepo(repoId);
    if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
    const outcome = await store.removeRepo(
      { repoId },
      {
        actor: actorOf(c),
        action: REPO_IMPORT_REMOVE,
        target: `repo:${repo.owner}/${repo.name}`.toLowerCase(),
        reason: `从驾驶舱移出 ${repo.owner}/${repo.name}`,
        via: c.get('via'),
        ok: true,
      },
    );
    if (outcome === 'not_found') throw new ApiError(404, 'repo_not_found', '没有这个项目');
    if (outcome === 'has_tasks') {
      return reply(c, RemoveRepoResponse, {
        removed: false,
        reason: '这个仓还挂着没结束的需求（排队或在做），先把它们处理掉再移出',
      });
    }
    return reply(c, RemoveRepoResponse, { removed: true });
  });
}
