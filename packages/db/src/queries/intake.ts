// 引擎拉单（#632 S2-2、S2-4b-3；packages/engine/src/jobs/intake.ts）要从库里读的两样：受管的仓（带「让 AI 接活」开关）、
// 一张单有没有任务行、在什么状态。任务行的创建走 api 的 pg-store（createTaskFromIssue：和操作记录同一事务，按仓加单号唯一）。
import { type CiPolicy, ciPolicyOf, type TaskState } from '@fleet-dao/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { repos, tasks } from '../schema/index.ts';

export interface IntakeRepoRow {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  testCommand: string;
  /** 「让 AI 接活」打开的时刻；null＝关着。 */
  autoDispatchSince: Date | null;
  /** 合并方式。库的默认是强制；列出来的是库里的原文，认不认由调用方用 ciPolicyOf。 */
  ciPolicy: CiPolicy;
}

/** 受管的所有仓（开关关着的也列：全关是正常的空闲，不是没扫到东西）。 */
export async function listIntakeRepos(db: Db): Promise<IntakeRepoRow[]> {
  const rows = await db
    .select({
      id: repos.id,
      owner: repos.owner,
      name: repos.name,
      defaultBranch: repos.defaultBranch,
      testCommand: repos.testCommand,
      autoDispatchSince: repos.autoDispatchSince,
      ciPolicy: repos.ciPolicy,
    })
    .from(repos)
    .orderBy(asc(repos.owner), asc(repos.name));
  return rows.map((r) => ({ ...r, ciPolicy: ciPolicyOf(r.ciPolicy) }));
}

/** 这张单的任务行（没有是 null）。派出过没有不在这里判。 */
export async function taskStateByIssue(
  db: Db,
  repoId: string,
  issueNumber: number,
): Promise<{ id: string; state: TaskState } | null> {
  const [row] = await db
    .select({ id: tasks.id, state: tasks.state })
    .from(tasks)
    .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, issueNumber)));
  return row ?? null;
}
