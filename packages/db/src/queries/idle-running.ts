// 看门狗用：executor=engine 且 state=running 的任务行，带上这张单此刻开着几条 runs（ended_at 为空）。
// 过不过期由引擎的判据定（jobs/idle-running.ts），这里不夹时长，免得两处各写一个阈值。
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { repos, runs, tasks } from '../schema/index.ts';

/**
 * 开着的会话数必须是认得出的非负整数。null、空串、小数、负数都抛，不当成 0。
 * count(*) 有的驱动回数字、有的回数字串，两种都收；别的形状不收。
 */
export function requireOpenRunCount(raw: unknown, slug: string): number {
  if (raw === null || raw === undefined || raw === '') {
    throw new Error(`${slug} 开着的会话数认不出（空），不当成没有会话`);
  }
  let n: number;
  if (typeof raw === 'bigint') {
    if (raw < 0n || raw > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${slug} 开着的会话数认不出（${raw.toString()}），不当成没有会话`);
    }
    n = Number(raw);
  } else if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw)) {
    n = Number(raw);
  } else {
    throw new Error(`${slug} 开着的会话数认不出（${String(raw)}），不当成没有会话`);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${slug} 开着的会话数认不出（${String(raw)}），不当成没有会话`);
  }
  return n;
}

/**
 * 这张单此刻开着几条会话（runs.ended_at 为空）。按仓名不分大小写对上唯一的任务行，
 * 再数挂在这行上的、或 workflowId 对得上的。没有任务行、对上多行、数认不出，都抛，不当成 0。
 */
export async function countOpenRunsForIssue(
  db: Db,
  repo: { owner: string; name: string },
  issueNumber: number,
  workflowId?: string,
): Promise<number> {
  const slug = `${repo.owner}/${repo.name}#${issueNumber}`;
  const matched = await db
    .select({ taskId: tasks.id })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(
      and(
        sql`lower(${repos.owner}) = lower(${repo.owner})`,
        sql`lower(${repos.name}) = lower(${repo.name})`,
        eq(tasks.issueNumber, issueNumber),
      ),
    );
  if (matched.length === 0) throw new Error(`${slug} 没有任务行，开着的会话数没查成`);
  if (matched.length > 1) {
    throw new Error(`${slug} 任务行对上 ${matched.length} 行，开着的会话数没查成`);
  }
  const taskId = matched[0]?.taskId;
  if (!taskId) throw new Error(`${slug} 没有任务行，开着的会话数没查成`);
  const [row] = await db
    .select({ n: sql<unknown>`count(*)::int` })
    .from(runs)
    .where(
      and(
        sql`${runs.endedAt} is null`,
        workflowId ? or(eq(runs.taskId, taskId), eq(runs.workflowId, workflowId)) : eq(runs.taskId, taskId),
      ),
    );
  return requireOpenRunCount(row?.n, slug);
}

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
