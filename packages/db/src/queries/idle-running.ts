// 看门狗用：executor=engine 且 state=running 的任务行，带上这张单此刻开着几条 runs（ended_at 为空）。
// 过不过期由引擎的判据定（jobs/idle-running.ts），这里不夹时长，免得两处各写一个阈值。
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { repos, runs, tasks } from '../schema/index.ts';

export interface RunningEngineTask {
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  /** 从没写过快照是 null。 */
  updatedAt: Date | null;
  doing: string | null;
  /** runs.ended_at 为空的行数。认不出就抛，不当成 0。 */
  openRuns: number;
}

/** 在干活的引擎任务。本机领的（executor=local）不在里面。读不到照抛。 */
export async function listRunningEngineTasks(db: Db): Promise<RunningEngineTask[]> {
  const openRuns = sql<number>`(
    select count(*)::int from ${runs} where ${runs.taskId} = ${tasks.id} and ${runs.endedAt} is null
  )`;
  const rows = await db
    .select({
      taskId: tasks.id,
      owner: repos.owner,
      name: repos.name,
      issueNumber: tasks.issueNumber,
      updatedAt: tasks.updatedAt,
      doing: tasks.doing,
      openRuns,
    })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(and(eq(tasks.state, 'running'), eq(tasks.executor, 'engine')))
    .orderBy(asc(repos.owner), asc(repos.name), asc(tasks.issueNumber));
  return rows.map((row) => {
    const n = typeof row.openRuns === 'number' ? row.openRuns : Number(row.openRuns);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`任务 ${row.taskId} 开着的会话数认不出（${String(row.openRuns)}）`);
    }
    return { ...row, openRuns: n };
  });
}
