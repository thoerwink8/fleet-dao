// 引擎拉单（#632 S2-2、S2-4b-3；packages/engine/src/jobs/intake.ts）要从库里读的两样：受管的仓（带「让 AI 接活」开关）、
// 一张单有没有任务行、在什么状态。任务行的创建走 api 的 pg-store（createTaskFromIssue：和操作记录同一事务，按仓加单号唯一）。
import { type CiMode, CiModeSchema, type TaskState } from '@fleet-dao/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
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
  /** 合并方式（#1877）：required＝强制 CI，skip＝不强制 CI。认不出的值抛错，不当成强制 CI。 */
  ciMode: CiMode;
}

/** 受管的所有仓（开关关着的也列：全关是正常的空闲，不是没扫到东西）。 */
export async function listIntakeRepos(db: Db): Promise<IntakeRepoRow[]> {
  return db
    .select({
      id: repos.id,
      owner: repos.owner,
      name: repos.name,
      defaultBranch: repos.defaultBranch,
      testCommand: repos.testCommand,
      autoDispatchSince: repos.autoDispatchSince,
      ciMode: repos.ciMode,
    })
    .from(repos)
    .orderBy(asc(repos.owner), asc(repos.name))
    .then((rows) => rows.map((r) => ({ ...r, ciMode: ciModeOf(r.ciMode) })));
}

function ciModeOf(raw: string): CiMode {
  const parsed = CiModeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`repos.ci_mode 认不出：${JSON.stringify(raw)}`);
  return parsed.data;
}

/**
 * 这个仓现在的合并方式（任务工作流每次走到「等 CI」之前现读，#1877）。库里没有这个仓、值认不出都抛错：
 * 不拿「强制 CI」冒充读到了（那样会把本该直接合并的单卡住，或反过来把不该跳过 CI 的放过去）。
 */
export async function readRepoCiMode(db: Db, repo: { owner: string; name: string }): Promise<CiMode> {
  const [row] = await db
    .select({ ciMode: repos.ciMode })
    .from(repos)
    .where(
      and(sql`lower(${repos.owner}) = lower(${repo.owner})`, sql`lower(${repos.name}) = lower(${repo.name})`),
    );
  if (!row) throw new Error(`库里没有仓 ${repo.owner}/${repo.name}，读不到它的合并方式`);
  return ciModeOf(row.ciMode);
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
