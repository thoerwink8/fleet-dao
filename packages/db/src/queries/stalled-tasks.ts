// 看门狗叫醒「点名和读回不一致」的旧挂起（#2742）要用的行：stalled、引擎在做，带上最近一条会话的工作流编号。
// 对不上哪一句由引擎判（jobs/model-mismatch-stall.ts），这里不夹标题，免得两处各写一句。
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { repos, runs, tasks } from '../schema/index.ts';

export interface StalledEngineTask {
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  doing: string | null;
  lastProblem: string | null;
  /** 最近一条 workflow_id 非空的 runs。没有是 null，调用方不许猜成第一代。 */
  workflowId: string | null;
}

/** 停下等人的引擎任务。本机领的不在里面。读不到照抛。 */
export async function listStalledEngineTasks(db: Db): Promise<StalledEngineTask[]> {
  const workflowId = sql<string | null>`(
    select ${runs.workflowId} from ${runs}
    where ${runs.taskId} = ${tasks.id} and ${runs.workflowId} is not null
    order by ${runs.startedAt} desc, ${runs.createdAt} desc
    limit 1
  )`;
  const rows = await db
    .select({
      taskId: tasks.id,
      owner: repos.owner,
      name: repos.name,
      issueNumber: tasks.issueNumber,
      doing: tasks.doing,
      lastProblem: tasks.lastProblem,
      workflowId,
    })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(and(eq(tasks.state, 'stalled'), eq(tasks.executor, 'engine')))
    .orderBy(asc(repos.owner), asc(repos.name), asc(tasks.issueNumber));
  return rows.map((row) => ({
    ...row,
    workflowId: typeof row.workflowId === 'string' && row.workflowId.length > 0 ? row.workflowId : null,
  }));
}
