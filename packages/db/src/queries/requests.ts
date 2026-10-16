// 需求（#2049）的两件后台事：引擎定时任务 request-sweep 每轮调 sweepRequests；单子状态由 B 片调 recordRequestIssueState 写进来。
// 判据只有一份（@fleet-dao/shared 的 request-rules.ts）：删了满 30 天硬删、讨论中闲置满 3 天收口（写原因并归档）、
// 已结案·不做马上归档、已结案·做的单子上线或关掉满 3 天归档。
// 改这里之前必须知道：
// - 硬删连消息、个人状态一起删（外键级联），每删一条写一条操作记录（engine 做的，via=engine），记下删的是哪条、几点删的、有几条消息。
// - 收口写进 close_reason（闲置几天、最后一句是谁说的），同时归档；人点「重开」由接口做，不在这里。
// - 每条在自己的事务里锁住再判一次：判的那一刻和删的那一刻之间，人可能点了「恢复」或又说了一句。
import {
  autoArchiveDue,
  idleCloseDue,
  idleCloseReason,
  purgeDue,
  type RequestDraft,
  type RequestIssueRef,
  type RequestIssueState,
  type RequestStatus,
  type TaskState,
} from '@fleet-dao/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, users } from '../schema/ops.ts';
import { requestIssueOpenings, requestMessages, requests } from '../schema/requests.ts';
import { asks, repos, stateChanges, subtasks, tasks } from '../schema/work.ts';

/** 定时任务在操作记录里的身份。 */
export const REQUEST_SWEEP_ACTOR = 'request-sweep';

export interface RequestSweepResult {
  /** 看了几条需求（表里全部）。 */
  scanned: number;
  /** 硬删了的需求号。 */
  purged: number[];
  /**
   * 自动归档了的需求号。讨论中闲置满 3 天收口的也在这里（收口同时归档）：
   * 引擎每小时任务只数这一列和 purged，不单列收口。
   */
  archived: number[];
  /**
   * 讨论中闲置满 3 天收口的需求号（这些号也在 archived 里）。
   * 可选：引擎测试里的假结果可以不带这一列。真跑一轮一定有。
   */
  idleClosed?: number[];
}

interface SweepRow {
  id: string;
  seq: number;
  status: RequestStatus;
  archivedAt: Date | null;
  deletedAt: Date | null;
  lastActivityAt: Date;
  issueRefs: RequestIssueRef[];
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function due(r: SweepRow, now: Date): 'purge' | 'idle_close' | 'archive' | null {
  if (purgeDue(iso(r.deletedAt), now)) return 'purge';
  if (
    idleCloseDue(
      { status: r.status, lastActivityAt: r.lastActivityAt.toISOString(), deletedAt: iso(r.deletedAt) },
      now,
    ) !== null
  ) {
    return 'idle_close';
  }
  const archive = autoArchiveDue(
    { status: r.status, archivedAt: iso(r.archivedAt), deletedAt: iso(r.deletedAt), issueRefs: r.issueRefs },
    now,
  );
  return archive ? 'archive' : null;
}

/** 最后一句是谁说的：人的话取显示名，指挥官就写「指挥官」。系统、引擎提问不算「说的」。没有是 null。 */
async function lastSpeaker(tx: Db, requestId: string): Promise<string | null> {
  const [m] = await tx
    .select({ kind: requestMessages.kind, name: users.displayName })
    .from(requestMessages)
    .leftJoin(users, eq(users.id, requestMessages.authorId))
    .where(
      and(eq(requestMessages.requestId, requestId), inArray(requestMessages.kind, ['human', 'commander'])),
    )
    .orderBy(desc(requestMessages.id))
    .limit(1);
  if (!m) return null;
  if (m.kind === 'commander') return '指挥官';
  const name = m.name?.trim();
  return name ? name : '（已不在的用户）';
}

const sweepColumns = {
  id: requests.id,
  seq: requests.seq,
  status: requests.status,
  archivedAt: requests.archivedAt,
  deletedAt: requests.deletedAt,
  lastActivityAt: requests.lastActivityAt,
  issueRefs: requests.issueRefs,
};

/**
 * 一轮：删了满 30 天的硬删，讨论中闲置满 3 天的收口（写原因、归档），该归档的归档。
 * 读不了库就抛（调用方记没跑成），不当成「没有要做的」。
 */
export async function sweepRequests(db: Db, now: Date): Promise<RequestSweepResult> {
  const rows: SweepRow[] = await db.select(sweepColumns).from(requests);
  const purged: number[] = [];
  const archived: number[] = [];
  const idleClosed: number[] = [];
  for (const candidate of rows) {
    if (due(candidate, now) === null) continue;
    const done = await db.transaction(async (tx) => {
      const [r] = await tx
        .select(sweepColumns)
        .from(requests)
        .where(eq(requests.id, candidate.id))
        .for('update');
      if (!r) return null;
      const what = due(r, now);
      if (what === 'purge') {
        const [facts] = await tx
          .select({
            draft: requests.draftJson,
            initiatorId: requests.initiatorId,
            repo: sql<string>`${repos.owner} || '/' || ${repos.name}`,
            messages: sql<number>`(select count(*)::int from ${requestMessages} where ${requestMessages.requestId} = ${requests.id})`,
          })
          .from(requests)
          .innerJoin(repos, eq(repos.id, requests.repoId))
          .where(eq(requests.id, r.id));
        await tx.delete(requests).where(eq(requests.id, r.id));
        await tx.insert(auditLog).values({
          at: now,
          actorKind: 'engine',
          actorId: REQUEST_SWEEP_ACTOR,
          action: 'request.purge',
          target: `request:${r.seq}`,
          before: {
            seq: r.seq,
            title: (facts?.draft as RequestDraft | undefined)?.title ?? null,
            repo: facts?.repo ?? null,
            initiatorId: facts?.initiatorId ?? null,
            status: r.status,
            deletedAt: iso(r.deletedAt),
            messages: facts?.messages ?? null,
          },
          after: null,
          reason: '删了满 30 天，连消息一起彻底删掉',
          via: 'engine',
        });
        return { what, seq: r.seq } as const;
      }
      if (what === 'archive') {
        await tx.update(requests).set({ archivedAt: now, updatedAt: now }).where(eq(requests.id, r.id));
        await tx.insert(auditLog).values({
          at: now,
          actorKind: 'engine',
          actorId: REQUEST_SWEEP_ACTOR,
          action: 'request.auto_archive',
          target: `request:${r.seq}`,
          before: { archivedAt: null },
          after: { archivedAt: now.toISOString() },
          reason:
            r.status === 'closed_drop'
              ? '已结案·不做：自动归档'
              : '已结案·做，单子上线或关掉满 3 天：自动归档',
          via: 'engine',
        });
        return { what, seq: r.seq } as const;
      }
      if (what === 'idle_close') {
        const days = idleCloseDue(
          { status: r.status, lastActivityAt: r.lastActivityAt.toISOString(), deletedAt: iso(r.deletedAt) },
          now,
        );
        if (days === null) return null;
        const reason = idleCloseReason(days, await lastSpeaker(tx, r.id));
        await tx
          .update(requests)
          .set({
            status: 'idle_closed',
            closedAt: now,
            closeReason: reason,
            archivedAt: now,
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(eq(requests.id, r.id));
        await tx.insert(requestMessages).values({
          requestId: r.id,
          kind: 'system',
          body: reason,
          createdAt: now,
        });
        await tx.insert(auditLog).values({
          at: now,
          actorKind: 'engine',
          actorId: REQUEST_SWEEP_ACTOR,
          action: 'request.idle_close',
          target: `request:${r.seq}`,
          before: { status: r.status, closeReason: null, archivedAt: null },
          after: { status: 'idle_closed', closeReason: reason, archivedAt: now.toISOString() },
          reason,
          via: 'engine',
        });
        return { what, seq: r.seq } as const;
      }
      return null;
    });
    if (done?.what === 'purge') purged.push(done.seq);
    if (done?.what === 'archive' || done?.what === 'idle_close') archived.push(done.seq);
    if (done?.what === 'idle_close') idleClosed.push(done.seq);
  }
  return { scanned: rows.length, purged, archived, idleClosed };
}

/**
 * 记下开出的一张单现在怎样（B 片从 GitHub、引擎任务表读到后调）：没有这张就加上，有就改状态和时刻。
 * 没有这条需求返回 false。状态没变不改时刻（「上线满 3 天」从第一次上线算）。
 */
export async function recordRequestIssueState(
  db: Db,
  input: { seq: number; repo: string; number: number; state: RequestIssueState; at: Date },
): Promise<boolean> {
  return db.transaction((tx) => applyRequestIssueState(tx, input));
}

/** recordRequestIssueState 的事务内版本：调用方已经开了事务（开单时和「结案」同一个事务写）。 */
export async function applyRequestIssueState(
  tx: Db,
  input: { seq: number; repo: string; number: number; state: RequestIssueState; at: Date },
): Promise<boolean> {
  const [r] = await tx
    .select({ id: requests.id, issueRefs: requests.issueRefs })
    .from(requests)
    .where(eq(requests.seq, input.seq))
    .for('update');
  if (!r) return false;
  const same = (i: RequestIssueRef) =>
    i.repo.toLowerCase() === input.repo.toLowerCase() && i.number === input.number;
  const existing = r.issueRefs.find(same);
  if (existing?.state === input.state) return true;
  const next: RequestIssueRef = {
    repo: input.repo,
    number: input.number,
    state: input.state,
    stateAt: input.at.toISOString(),
  };
  const refs = existing ? r.issueRefs.map((i) => (same(i) ? next : i)) : [...r.issueRefs, next];
  await tx.update(requests).set({ issueRefs: refs, updatedAt: input.at }).where(eq(requests.id, r.id));
  return true;
}

// —— 开单之后的联动（#2060，母单 #2047 第 B 片）：进度同步、引擎提问、引擎认提出人 ——

/** 进度同步要看的一张单：已结案·做的需求里还没上线、没关掉的。 */
export interface RequestIssueToSync {
  seq: number;
  repoId: string;
  owner: string;
  name: string;
  number: number;
  state: RequestIssueState;
}

/** 已结案·做、没删、没归档的需求里，开出的单还没上线也没关掉的（含「已合并」：它还在等上线）。读不了库就抛。 */
export async function listRequestIssuesToSync(db: Db): Promise<RequestIssueToSync[]> {
  const rows = await db
    .select({
      seq: requests.seq,
      repoId: requests.repoId,
      owner: repos.owner,
      name: repos.name,
      issueRefs: requests.issueRefs,
    })
    .from(requests)
    .innerJoin(repos, eq(repos.id, requests.repoId))
    .where(and(eq(requests.status, 'closed_do'), isNull(requests.deletedAt), isNull(requests.archivedAt)));
  return rows.flatMap((r) =>
    r.issueRefs
      .filter((i) => i.state !== 'deployed' && i.state !== 'closed')
      .map((i) => ({
        seq: r.seq,
        repoId: r.repoId,
        owner: r.owner,
        name: r.name,
        number: i.number,
        state: i.state,
      })),
  );
}

/** 引擎任务表里这张单的现状：任务状态、子任务合了几个、做完的时刻、没人答的追问。 */
export interface IssueTaskFacts {
  taskId: string;
  state: TaskState;
  why: string | undefined;
  subtasks: { total: number; merged: number };
  /** 任务最近一次进 done 的时刻（状态变化记录里取）；没进过 done 是 null。 */
  doneAt: Date | null;
  openAsks: { id: string; question: string; options: string[]; askedAt: Date }[];
}

/** 这张单的任务行；引擎还没接（没有任务行）是 null。读不了库就抛，不当成「没接」。 */
export async function readIssueTaskFacts(
  db: Db,
  input: { repoId: string; issueNumber: number },
): Promise<IssueTaskFacts | null> {
  const [t] = await db
    .select({ id: tasks.id, state: tasks.state, doing: tasks.doing, lastProblem: tasks.lastProblem })
    .from(tasks)
    .where(and(eq(tasks.repoId, input.repoId), eq(tasks.issueNumber, input.issueNumber)));
  if (!t) return null;
  const subs = await db
    .select({ state: subtasks.state })
    .from(subtasks)
    .where(and(eq(subtasks.taskId, t.id), isNull(subtasks.supersededAt)));
  const [done] = await db
    .select({ at: stateChanges.at })
    .from(stateChanges)
    .where(
      and(eq(stateChanges.entity, 'task'), eq(stateChanges.entityId, t.id), eq(stateChanges.toState, 'done')),
    )
    .orderBy(desc(stateChanges.id))
    .limit(1);
  const open = await db
    .select({ id: asks.id, question: asks.question, options: asks.options, askedAt: asks.askedAt })
    .from(asks)
    .where(and(eq(asks.taskId, t.id), isNull(asks.answer)))
    .orderBy(asks.askedAt);
  return {
    taskId: t.id,
    state: t.state,
    why: t.lastProblem ?? t.doing ?? undefined,
    subtasks: { total: subs.length, merged: subs.filter((s) => s.state === 'merged').length },
    doneAt: done?.at ?? null,
    openAsks: open,
  };
}

/**
 * 在对话里追加一张进度卡（系统消息，「#12 动手中 · …」）。同一张单上一张进度卡一模一样就不重复追加。
 * 追加的同时改需求的 last_activity_at：实时推送（SSE）报的就是 requests 这张表的变化。没有这条需求返回 'no_request'。
 */
export async function appendProgressCard(
  db: Db,
  input: { seq: number; issueNumber: number; body: string; at: Date },
): Promise<'appended' | 'unchanged' | 'no_request'> {
  return db.transaction(async (tx) => {
    const [r] = await tx
      .select({ id: requests.id })
      .from(requests)
      .where(eq(requests.seq, input.seq))
      .for('update');
    if (!r) return 'no_request';
    const [last] = await tx
      .select({ body: requestMessages.body })
      .from(requestMessages)
      .where(
        and(
          eq(requestMessages.requestId, r.id),
          eq(requestMessages.kind, 'system'),
          sql`${requestMessages.body} like ${`#${input.issueNumber} %`}`,
        ),
      )
      .orderBy(desc(requestMessages.id))
      .limit(1);
    if (last?.body === input.body) return 'unchanged';
    await tx
      .insert(requestMessages)
      .values({ requestId: r.id, kind: 'system', body: input.body, createdAt: input.at });
    await tx
      .update(requests)
      .set({ lastActivityAt: input.at, updatedAt: input.at })
      .where(eq(requests.id, r.id));
    return 'appended';
  });
}

/**
 * 引擎在单上提了问：在对应需求的对话里生成一条「引擎提问」消息，绑定那条评论（网址，评论号在末尾），答复状态记「待答」。
 * 同一条评论只生成一条（再调返回 false）。没有这条需求返回 'no_request'。
 */
export async function recordEngineAsk(
  db: Db,
  input: { seq: number; commentUrl: string; body: string; at: Date },
): Promise<'created' | 'exists' | 'no_request'> {
  return db.transaction(async (tx) => {
    const [r] = await tx
      .select({ id: requests.id })
      .from(requests)
      .where(eq(requests.seq, input.seq))
      .for('update');
    if (!r) return 'no_request';
    const inserted = await tx
      .insert(requestMessages)
      .values({
        requestId: r.id,
        kind: 'engine_ask',
        body: input.body,
        githubCommentRef: input.commentUrl,
        answerState: 'pending',
        createdAt: input.at,
      })
      .onConflictDoNothing()
      .returning({ id: requestMessages.id });
    if (inserted.length === 0) return 'exists';
    await tx
      .update(requests)
      .set({ lastActivityAt: input.at, updatedAt: input.at })
      .where(eq(requests.id, r.id));
    return 'created';
  });
}

/** 正文末尾「来自驾驶舱 需求 N：」的 N（取最后一处：原话里引用的不算）。 */
export function requestSeqFromIssueBody(body: string): number | null {
  const all = [...body.matchAll(/来自驾驶舱 需求 (\d{1,9})：/g)];
  const last = all.at(-1)?.[1];
  return last ? Number(last) : null;
}

/**
 * 引擎拉单时认提出人（方案第六节：requested_by 写进库，这才是引擎认人的依据）：单是「引擎」机器人开的，GitHub 上的作者认不出
 * 是谁。正文末尾写着「来自驾驶舱 需求 N」，按它找到这条需求在同一个仓里的开单记录，取点按钮那一刻写下的提出人。
 * 找不到（不是驾驶舱开的、需求不在这个仓、没有开单记录、记录已经开出了别的号）返回 null，调用方照旧按作者认。
 */
export async function requesterForRequestIssue(
  db: Db,
  input: { repoId: string; issueNumber: number; body: string },
): Promise<{ requestedBy: string; seq: number } | null> {
  const seq = requestSeqFromIssueBody(input.body);
  if (seq === null) return null;
  const rows = await db
    .select({
      requestedBy: requestIssueOpenings.requestedBy,
      state: requestIssueOpenings.state,
      issueNumber: requestIssueOpenings.issueNumber,
    })
    .from(requestIssueOpenings)
    .innerJoin(requests, eq(requests.id, requestIssueOpenings.requestId))
    .where(and(eq(requests.seq, seq), eq(requests.repoId, input.repoId)))
    .orderBy(desc(requestIssueOpenings.draftVersion));
  const hit = rows.find(
    (o) =>
      (o.state === 'opened' && o.issueNumber === input.issueNumber) ||
      // 正在开：GitHub 那边单已经建好、库里还没来得及记号，引擎先到了
      (o.state === 'opening' && o.issueNumber === null),
  );
  return hit ? { requestedBy: hit.requestedBy, seq } : null;
}
