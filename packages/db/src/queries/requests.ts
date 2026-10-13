// 需求（#2049）的两件后台事：引擎定时任务 request-sweep 每轮调 sweepRequests；单子状态由 B 片调 recordRequestIssueState 写进来。
// 判据只有一份（@fleet-dao/shared 的 request-rules.ts）：删了满 30 天硬删、已结案·不做马上归档、已结案·做的单子上线或关掉满 3 天归档。
// 改这里之前必须知道：
// - 硬删连消息、个人状态一起删（外键级联），每删一条写一条操作记录（engine 做的，via=engine），记下删的是哪条、几点删的、有几条消息。
// - 每条在自己的事务里锁住再判一次：判的那一刻和删的那一刻之间，人可能点了「恢复」。
import {
  autoArchiveDue,
  purgeDue,
  type RequestDraft,
  type RequestIssueRef,
  type RequestIssueState,
  type RequestStatus,
} from '@fleet-dao/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog } from '../schema/ops.ts';
import { requestMessages, requests } from '../schema/requests.ts';
import { repos } from '../schema/work.ts';

/** 定时任务在操作记录里的身份。 */
export const REQUEST_SWEEP_ACTOR = 'request-sweep';

export interface RequestSweepResult {
  /** 看了几条需求（表里全部）。 */
  scanned: number;
  /** 硬删了的需求号。 */
  purged: number[];
  /** 自动归档了的需求号。 */
  archived: number[];
}

interface SweepRow {
  id: string;
  seq: number;
  status: RequestStatus;
  archivedAt: Date | null;
  deletedAt: Date | null;
  issueRefs: RequestIssueRef[];
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function due(r: SweepRow, now: Date): 'purge' | 'archive' | null {
  if (purgeDue(iso(r.deletedAt), now)) return 'purge';
  const archive = autoArchiveDue(
    { status: r.status, archivedAt: iso(r.archivedAt), deletedAt: iso(r.deletedAt), issueRefs: r.issueRefs },
    now,
  );
  return archive ? 'archive' : null;
}

const sweepColumns = {
  id: requests.id,
  seq: requests.seq,
  status: requests.status,
  archivedAt: requests.archivedAt,
  deletedAt: requests.deletedAt,
  issueRefs: requests.issueRefs,
};

/**
 * 一轮：删了满 30 天的硬删，该归档的归档。读不了库就抛（调用方记没跑成），不当成「没有要做的」。
 */
export async function sweepRequests(db: Db, now: Date): Promise<RequestSweepResult> {
  const rows: SweepRow[] = await db.select(sweepColumns).from(requests);
  const purged: number[] = [];
  const archived: number[] = [];
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
      return null;
    });
    if (done?.what === 'purge') purged.push(done.seq);
    if (done?.what === 'archive') archived.push(done.seq);
  }
  return { scanned: rows.length, purged, archived };
}

/**
 * 记下开出的一张单现在怎样（B 片从 GitHub、引擎任务表读到后调）：没有这张就加上，有就改状态和时刻。
 * 没有这条需求返回 false。状态没变不改时刻（「上线满 3 天」从第一次上线算）。
 */
export async function recordRequestIssueState(
  db: Db,
  input: { seq: number; repo: string; number: number; state: RequestIssueState; at: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
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
  });
}
