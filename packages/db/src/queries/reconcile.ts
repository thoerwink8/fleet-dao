// 每小时对账的两处核对要从库里认的事：没结束的单（去问它的需求工作流还在不在跑、投递上记没记为什么不派）、受管的仓
// （去对最近合了的 PR）、合了的 PR 对上的单记没记账（会话结局、用量、关单）。
// 终态的单不在第一份清单里：做完、叫停、没做完都不再要求有一条在跑的工作流。
import type { RunOutcome, TaskState } from '@fleet-dao/shared';
import { and, asc, desc, eq, gte, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { TERMINAL_TASK_STATES } from '../schema/enums.ts';
import {
  githubEvents,
  githubEventVersions,
  pullRequests,
  repos,
  sessionRuns,
  tasks,
} from '../schema/index.ts';

export interface ActiveTaskRef {
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  state: TaskState;
  /** 最近一次快照；从没写过是 null（不算「刚更新」，工作流不在跑就要查）。 */
  updatedAt: Date | null;
  /** 这个项目「让 AI 接活」开着（repos.auto_dispatch_since 不空）。 */
  autoDispatch: boolean;
}

/** 没结束的单（含排队）：仓、issue 号、状态、最近更新、项目接活开没开。终态的不返回。 */
export async function activeTaskRefs(db: Db): Promise<ActiveTaskRef[]> {
  return db
    .select({
      taskId: tasks.id,
      owner: repos.owner,
      name: repos.name,
      issueNumber: tasks.issueNumber,
      state: tasks.state,
      updatedAt: tasks.updatedAt,
      autoDispatch: sql<boolean>`${repos.autoDispatchSince} is not null`,
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

export interface IssueDeliveryRef {
  deliveryId: string;
  status: (typeof githubEvents.$inferSelect)['status'];
  reason: string | null;
  /** 放进来之后做了什么：接活写的 `workflow=<结果>` 就在这里（拉起了、为什么不派）。 */
  note: string | null;
  receivedAt: Date;
}

/**
 * 这张 issue 最近一次的 issues 投递（按它带的那一版 issue 的 updated_at，同一版按收到的先后）：接活记的派没派、为什么不派
 * 在它的 note 上；补拉就重放它。评论事件也带着 issue 那一版，但评论不派单，不算。没有是 null。
 */
export async function latestIssueDelivery(
  db: Db,
  ref: { owner: string; name: string; issueNumber: number },
): Promise<IssueDeliveryRef | null> {
  const object = `${`${ref.owner}/${ref.name}`.toLowerCase()}:issue:${ref.issueNumber}`;
  const [row] = await db
    .select({
      deliveryId: githubEvents.deliveryId,
      status: githubEvents.status,
      reason: githubEvents.reason,
      note: githubEvents.note,
      receivedAt: githubEvents.receivedAt,
    })
    .from(githubEventVersions)
    .innerJoin(githubEvents, eq(githubEvents.deliveryId, githubEventVersions.deliveryId))
    .where(and(eq(githubEventVersions.object, object), eq(githubEvents.event, 'issues')))
    .orderBy(desc(githubEventVersions.version), desc(githubEvents.receivedAt))
    .limit(1);
  return row ?? null;
}

export interface LedgerSession {
  runId: string;
  stage: string;
  startedAt: Date | null;
  endedAt: Date | null;
  outcome: RunOutcome | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** 一条合了的 PR 和它对上的那张单：PR 头分支就是这张单会话干活的分支（引擎开的 PR 才对得上）。 */
export interface MergedPrLedger {
  owner: string;
  name: string;
  prNumber: number;
  /** 镜像里这条 PR 最后更新的时刻（合并那一下）。 */
  prUpdatedAt: Date;
  taskId: string;
  issueNumber: number;
  taskState: TaskState;
  sessions: LedgerSession[];
}

/**
 * 镜像里合了的 PR（since 以后更新过的，外加 prs 点名的——还开着的提醒要复查，出了回看窗口也得查到），只留对得上一张单的
 * （有会话在它的头分支上干过活）；每条带上那张单所有的会话。
 */
export async function mergedPrLedgers(
  db: Db,
  input: { since: Date; prs?: readonly { owner: string; name: string; number: number }[] },
): Promise<MergedPrLedger[]> {
  const named = (input.prs ?? []).map((p) =>
    and(eq(repos.owner, p.owner), eq(repos.name, p.name), eq(pullRequests.number, p.number)),
  );
  const pairs = await db
    .selectDistinct({
      owner: repos.owner,
      name: repos.name,
      prNumber: pullRequests.number,
      prUpdatedAt: pullRequests.updatedAt,
      taskId: tasks.id,
      issueNumber: tasks.issueNumber,
      taskState: tasks.state,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .innerJoin(tasks, eq(tasks.repoId, pullRequests.repoId))
    .innerJoin(
      sessionRuns,
      and(eq(sessionRuns.taskId, tasks.id), eq(sessionRuns.branch, pullRequests.headRef)),
    )
    .where(
      and(
        eq(pullRequests.state, 'merged'),
        isNotNull(sessionRuns.branch),
        or(gte(pullRequests.updatedAt, input.since), ...named),
      ),
    )
    .orderBy(asc(repos.owner), asc(repos.name), asc(pullRequests.number));
  if (pairs.length === 0) return [];
  const runs = await db
    .select({
      taskId: sessionRuns.taskId,
      runId: sessionRuns.id,
      stage: sessionRuns.stage,
      startedAt: sessionRuns.startedAt,
      endedAt: sessionRuns.endedAt,
      outcome: sessionRuns.outcome,
      inputTokens: sessionRuns.inputTokens,
      outputTokens: sessionRuns.outputTokens,
    })
    .from(sessionRuns)
    .where(inArray(sessionRuns.taskId, [...new Set(pairs.map((p) => p.taskId))]))
    .orderBy(asc(sessionRuns.queuedAt));
  return pairs.map((p) => ({
    ...p,
    sessions: runs.filter((r) => r.taskId === p.taskId).map(({ taskId: _t, ...r }) => r),
  }));
}
