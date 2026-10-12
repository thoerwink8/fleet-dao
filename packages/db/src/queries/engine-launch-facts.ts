// 引擎起会话要的事实：任务属于哪个仓、哪张 issue（含仓的测试命令），路由的池、会话用户、上游模型串、配的思考档位。
import type { HostId, OrgKind, RunAsUser, SessionEffort, StageKind } from '@fleet-dao/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { models, pools, repos, routes, routingPurposeModels, tasks } from '../schema/index.ts';

export interface TaskContext {
  taskId: string;
  issueNumber: number;
  title: string;
  rawRequest: string;
  specDir: string | null;
  acceptance: string[];
  repo: {
    id: string;
    owner: string;
    name: string;
    defaultBranch: string;
    /** 仓的测试命令（repos.test_command，建仓时填）。 */
    testCommand: string | null;
  };
}

/** 起会话、拼接力任务书要的：任务属于哪个仓、哪张 issue，连同仓的测试命令。任务不在返回 null。 */
export async function taskContext(db: Db, taskId: string): Promise<TaskContext | null> {
  const [row] = await db
    .select({ task: tasks, repo: repos })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(eq(tasks.id, taskId));
  if (!row) return null;
  return {
    taskId: row.task.id,
    issueNumber: row.task.issueNumber,
    title: row.task.title,
    rawRequest: row.task.rawRequest,
    specDir: row.task.specDir,
    acceptance: row.task.acceptance,
    repo: {
      id: row.repo.id,
      owner: row.repo.owner,
      name: row.repo.name,
      defaultBranch: row.repo.defaultBranch,
      testCommand: row.repo.testCommand,
    },
  };
}

export interface RouteLaunchFacts {
  routeId: string;
  channelId: string;
  poolId: string;
  modelId: string;
  hostId: HostId;
  upstreamModel: string | null;
  /** Mirasim 记下的执行体（routes.executor）。空 = 起会话时按前缀现判。 */
  executor?: string | null;
  runAsUser: RunAsUser | null;
  orgKind: OrgKind | null;
  /**
   * 这个用途下这个模型的思考档位（routing_purpose_models.effort，#1958）。
   * 没给用途、这个用途没排这个模型、或那一格没配，是 null（起会话用骨架 defaults.effort）。
   * 不读 routing_catalog.effort。改用途表的档位，下一次带上同一个用途读到的就是新的。
   */
  effort: SessionEffort | null;
}

/**
 * 起会话要的：这条路由的池、会话用户、执行方式、上游模型串、这个用途配的思考档位。路由不在返回 null。
 * purpose 不给时 effort 是 null（调用方没说用途，不能去猜别的用途或路由上的旧档）。
 */
export async function routeLaunchFacts(
  db: Db,
  routeId: string,
  purpose?: StageKind,
): Promise<RouteLaunchFacts | null> {
  const [row] = await db
    .select({ route: routes, pool: pools })
    .from(routes)
    .innerJoin(pools, eq(pools.id, routes.poolId))
    .where(eq(routes.id, routeId));
  if (!row) return null;
  let effort: SessionEffort | null = null;
  if (purpose !== undefined) {
    const [purposeRow] = await db
      .select({ effort: routingPurposeModels.effort })
      .from(routingPurposeModels)
      .where(
        and(eq(routingPurposeModels.purpose, purpose), eq(routingPurposeModels.modelId, row.route.modelId)),
      );
    effort = purposeRow?.effort ?? null;
  }
  return {
    routeId: row.route.id,
    channelId: row.route.channelId,
    poolId: row.pool.id,
    modelId: row.route.modelId,
    hostId: row.route.hostId,
    upstreamModel: row.route.upstreamModel,
    executor: row.route.executor,
    runAsUser: row.pool.runAsUser,
    orgKind: row.pool.orgKind,
    effort,
  };
}

/** Mirasim 起会话校验用的型号：目录里的模型 id，加上每条路由的上游串。引擎每次现读，插头不另存一份。 */
export async function launchModelNames(db: Db): Promise<string[]> {
  const [modelRows, routeRows] = await Promise.all([
    db.select({ id: models.id }).from(models),
    db.select({ upstream: routes.upstreamModel }).from(routes),
  ]);
  const names = new Set<string>();
  for (const row of modelRows) names.add(row.id);
  for (const row of routeRows) {
    if (row.upstream) names.add(row.upstream);
  }
  return [...names];
}
