// 工作树对账（引擎每小时对账的一项）要从库里认的事：一棵树是哪张需求的（需求、子任务的编号，好去 Temporal 看还在不在跑）、
// 一条分支推上去过哪些头（pull_requests 镜像：树里的提交是不是都推过）、一条「工作树没收掉」的提醒说的是哪棵树、
// 哪些目录里还有没结束的会话（有就不碰那棵树）。
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { pullRequests, repos, sessionRuns, subtasks, tasks } from '../schema/index.ts';

export interface IssueWorkFacts {
  taskId: string;
  state: (typeof tasks.$inferSelect)['state'];
  /** 这张需求的全部子任务（含重拆方案作废了的：它们的工作流也可能还在收尾）。 */
  subtasks: { id: string; key: string | null }[];
}

/** 某个仓（owner/name 逐字比）某张 issue 的需求和它的子任务；库里没有这张需求回 null。 */
export async function issueWorkFacts(
  db: Db,
  input: { owner: string; name: string; issueNumber: number },
): Promise<IssueWorkFacts | null> {
  const [task] = await db
    .select({ id: tasks.id, state: tasks.state })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(
      and(eq(repos.owner, input.owner), eq(repos.name, input.name), eq(tasks.issueNumber, input.issueNumber)),
    );
  if (!task) return null;
  const rows = await db
    .select({ id: subtasks.id, key: subtasks.key })
    .from(subtasks)
    .where(eq(subtasks.taskId, task.id));
  return { taskId: task.id, state: task.state, subtasks: rows };
}

/** 这个仓这条分支上的 PR 的头（开着、关了、合了的都算：推上去过就在 GitHub 上）。没有 PR 回空。 */
export async function prHeadsOfBranch(
  db: Db,
  input: { owner: string; name: string; branch: string },
): Promise<string[]> {
  const rows = await db
    .select({ head: pullRequests.headSha })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(eq(repos.owner, input.owner), eq(repos.name, input.name), eq(pullRequests.headRef, input.branch)),
    );
  return [...new Set(rows.map((r) => r.head))];
}

export interface SubtaskTreeRef {
  subtaskId: string;
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  /** 方案里的子任务编号；老数据可能没有（null），那就拼不出树在哪。 */
  key: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 子任务编号 → 它的树在哪个仓、哪张 issue、哪个 key。库里没有的编号（包括不是 UUID 的）不在结果里。 */
export async function subtaskTreeRefs(db: Db, ids: readonly string[]): Promise<SubtaskTreeRef[]> {
  const wanted = ids.filter((id) => UUID.test(id));
  if (wanted.length === 0) return [];
  return db
    .select({
      subtaskId: subtasks.id,
      taskId: tasks.id,
      owner: repos.owner,
      name: repos.name,
      issueNumber: tasks.issueNumber,
      key: subtasks.key,
    })
    .from(subtasks)
    .innerJoin(tasks, eq(tasks.id, subtasks.taskId))
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(inArray(subtasks.id, wanted));
}

export interface OpenSessionTree {
  runId: string;
  stage: (typeof sessionRuns.$inferSelect)['stage'];
  queuedAt: Date;
  /** 会话起在哪个目录（子任务的树、检出副本），和引擎建树时拼的路径逐字一样。 */
  path: string;
}

/**
 * 还没结束的会话（ended_at 为空）起在哪些目录里：每小时对账删树之前看，树里还有会话就不碰——不管它是哪种工作流起的，
 * 也不管那条工作流还在不在（被强行终止的工作流留下的会话还活着，#247）。
 */
export async function openSessionTrees(db: Db): Promise<OpenSessionTree[]> {
  const rows = await db
    .select({
      runId: sessionRuns.id,
      stage: sessionRuns.stage,
      queuedAt: sessionRuns.queuedAt,
      path: sessionRuns.worktreePath,
    })
    .from(sessionRuns)
    .where(and(isNull(sessionRuns.endedAt), isNotNull(sessionRuns.worktreePath)));
  return rows.flatMap((r) => (r.path ? [{ ...r, path: r.path }] : []));
}

/** 需求此刻的状态；没有这个需求（包括编号不是 UUID）回 null。 */
export async function taskStateOf(
  db: Db,
  taskId: string,
): Promise<(typeof tasks.$inferSelect)['state'] | null> {
  if (!UUID.test(taskId)) return null;
  const [row] = await db.select({ state: tasks.state }).from(tasks).where(eq(tasks.id, taskId));
  return row?.state ?? null;
}
