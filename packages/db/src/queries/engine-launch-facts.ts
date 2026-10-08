// 引擎起会话要的事实：任务属于哪个仓、哪张 issue（含仓的测试命令），路由的池、会话用户、上游模型串、配的思考档位。
import type { HostId, OrgKind, RunAsUser, SessionEffort } from '@fleet-dao/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { pools, repos, routes, routingCatalog, tasks } from '../schema/index.ts';

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
   * 驾驶舱给这条路由配的思考档位（routing_catalog.effort，#470）。没配、或这条路由没挂进路由两层，是 null（起会话用 high）。
   * 起会话时现读：驾驶舱改了，下一个会话就照新的。
   */
  effort: SessionEffort | null;
}

/** 起会话要的：这条路由的池、会话用户、执行方式、上游模型串、配的思考档位。路由不在返回 null。 */
export async function routeLaunchFacts(db: Db, routeId: string): Promise<RouteLaunchFacts | null> {
  const [row] = await db
    .select({ route: routes, pool: pools, effort: routingCatalog.effort })
    .from(routes)
    .innerJoin(pools, eq(pools.id, routes.poolId))
    // 一条路由只挂在它自己的模型下（复合外键），最多一行
    .leftJoin(
      routingCatalog,
      and(eq(routingCatalog.routeId, routes.id), eq(routingCatalog.modelId, routes.modelId)),
    )
    .where(eq(routes.id, routeId));
  if (!row) return null;
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
    effort: row.effort,
  };
}
