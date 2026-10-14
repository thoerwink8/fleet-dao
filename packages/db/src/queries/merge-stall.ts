// 看门狗的「主线 N 小时没合 PR」报警（决定 0093，engine 的 jobs/merge-stall.ts）要的事实：每个开着「让 AI 接活」的仓，
// 最近一次合并（PR 镜像 pull_requests.merged_at）、引擎手上在做的单几张、拉单最近一轮记下的等空位的单几张。
// 只读。读不到照抛：看门狗这一轮记没查成，不当成「合过」「没有待做的单」。
import type { TaskState } from '@fleet-dao/shared';
import { and, count, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { pullRequests, repos, tasks } from '../schema/index.ts';
import { readIntakeWaiting } from './intake-history.ts';

/** 引擎手上在做、做下去会出 PR 的单：分诊、写方案、在干、在合并。在等人（asking、stalled）的不算：那要人动，不是引擎可接的。 */
export const IN_FLIGHT_TASK_STATES = [
  'triaging',
  'planning',
  'running',
  'merging',
] as const satisfies readonly TaskState[];

export interface RepoMergeFacts {
  repoId: string;
  /** owner/name。 */
  repo: string;
  /** 「让 AI 接活」打开的时刻。关着的仓不在名单里。 */
  dispatchSince: Date;
  /** 最近合并的一个 PR；镜像里一个都没有是 null。 */
  lastMerged: { number: number; at: Date } | null;
  /** 引擎手上在做的单几张（IN_FLIGHT_TASK_STATES）。 */
  inFlight: number;
  /** 拉单最近一轮记下的「过了准入、只因没空位没起」的单几张；那一轮没读成这个仓、或拉单从没记过是 null。 */
  waiting: number | null;
}

export interface MergeStallFacts {
  repos: RepoMergeFacts[];
  /** 拉单最近一轮记下等空位单数的时刻；从没记过是 null。 */
  waitingAt: Date | null;
}

export async function mergeStallFacts(db: Db): Promise<MergeStallFacts> {
  const on = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name, since: repos.autoDispatchSince })
    .from(repos)
    .where(isNotNull(repos.autoDispatchSince))
    .orderBy(repos.owner, repos.name);
  const waiting = await readIntakeWaiting(db);
  const out: RepoMergeFacts[] = [];
  for (const r of on) {
    const [last] = await db
      .select({ number: pullRequests.number, at: pullRequests.mergedAt })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, r.id), isNotNull(pullRequests.mergedAt)))
      .orderBy(desc(pullRequests.mergedAt))
      .limit(1);
    const [busy] = await db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.repoId, r.id), inArray(tasks.state, [...IN_FLIGHT_TASK_STATES])));
    const n = waiting?.byRepo[r.id];
    out.push({
      repoId: r.id,
      repo: `${r.owner}/${r.name}`,
      dispatchSince: r.since as Date,
      lastMerged: last?.at ? { number: last.number, at: last.at } : null,
      inFlight: busy?.n ?? 0,
      waiting: typeof n === 'number' ? n : null,
    });
  }
  return { repos: out, waitingAt: waiting?.at ?? null };
}
