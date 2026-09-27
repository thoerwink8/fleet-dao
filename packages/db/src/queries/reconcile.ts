// 每小时对账的三处核对要从库里认的事：没结束的单（去问它的需求工作流还在不在跑）、受管的仓（去对最近合了的 PR）。
// 终态的单不在这里：做完、叫停、没做完都不再要求有一条在跑的工作流。
import type { TaskState } from '@fleet-dao/shared';
import { asc, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { TERMINAL_TASK_STATES } from '../schema/enums.ts';
import { repos, tasks } from '../schema/index.ts';

export interface ActiveTaskRef {
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  state: TaskState;
  /** 最近一次快照；从没写过是 null（不算「刚更新」，工作流不在跑就要报）。 */
  updatedAt: Date | null;
}

/** 没结束的单（含排队）：仓、issue 号、状态、最近更新。终态的不返回。 */
export async function activeTaskRefs(db: Db): Promise<ActiveTaskRef[]> {
  return db
    .select({
      taskId: tasks.id,
      owner: repos.owner,
      name: repos.name,
      issueNumber: tasks.issueNumber,
      state: tasks.state,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(notInArray(tasks.state, [...TERMINAL_TASK_STATES]))
    .orderBy(asc(repos.owner), asc(repos.name), asc(tasks.issueNumber));
}

export interface ReconcileRepoRef {
  owner: string;
  name: string;
}

/** 受管的仓（repos 表每一行）。每小时对账按它去对最近合了的 PR。 */
export async function reconcileRepos(db: Db): Promise<ReconcileRepoRef[]> {
  return db
    .select({ owner: repos.owner, name: repos.name })
    .from(repos)
    .orderBy(asc(repos.owner), asc(repos.name));
}
