// 引擎起会话要的事实：任务属于哪个仓、哪张 issue（含仓的测试命令），路由的池、会话用户、上游模型串、配的思考档位。
import type { HostId, OrgKind, RunAsUser, SessionEffort, StageKind } from '@fleet-dao/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { pools, repos, routes, routingPurposeModels, tasks } from '../schema/index.ts';

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
   * 这个用途下这个模型的思考档位（routing_purpose_models.effort，#1967）。没配、或这个模型没挂进用途表，是 null
   * （起会话用骨架 defaults.effort）。不读 routing_catalog.effort。带了 purpose 就读那一格；没带、各用途档位一样，用那一档；
   * 没带、档位还不一样，抛错，不挑一档。
   */
  effort: SessionEffort | null;
}

/**
 * 同一模型在各用途下的档。带了用途就只看那一格（没有这一格 = 没配）。没带用途：一行都没有 = 没配；都一样用那一档；
 * 不一样抛错，调用方不起会话。
 */
function purposeEffort(
  modelId: string,
  rows: { purpose: string; effort: SessionEffort | null }[],
  purpose: StageKind | undefined,
): SessionEffort | null {
  if (purpose !== undefined) return rows[0]?.effort ?? null;
  if (rows.length === 0) return null;
  const distinct = [...new Set(rows.map((r) => r.effort ?? null))];
  if (distinct.length > 1) {
    const listed = rows.map((r) => `${r.purpose}=${r.effort ?? '没配'}`).join('、');
    throw new Error(
      `模型 ${modelId} 在不同用途下的思考档位不一样（${listed}），起会话没说用途，不知道照哪一档`,
    );
  }
  return distinct[0] ?? null;
}

/** 起会话要的：这条路由的池、会话用户、执行方式、上游模型串、这个用途下的思考档位。路由不在返回 null。 */
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
  const purposeRows = await db
    .select({ purpose: routingPurposeModels.purpose, effort: routingPurposeModels.effort })
    .from(routingPurposeModels)
    .where(
      purpose === undefined
        ? eq(routingPurposeModels.modelId, row.route.modelId)
        : and(eq(routingPurposeModels.modelId, row.route.modelId), eq(routingPurposeModels.purpose, purpose)),
    );
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
    effort: purposeEffort(row.route.modelId, purposeRows, purpose),
  };
}
