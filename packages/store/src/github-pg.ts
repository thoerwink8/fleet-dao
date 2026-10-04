// GitHub 包要的几本账的 Postgres 实现：幂等账（idempotency_keys）、PR 镜像（pull_requests、repos、tasks 的几条查询）、跨工人的锁。
// 接口、内存实现和锁的逻辑都在 @fleet-dao/github（它是纯 GitHub API 包，不碰库）；这里只管「账存在 Postgres 里」。
// #901 ⑤：这几个函数原来在 packages/github/src/{idempotency,ledger}.ts，函数体逐字搬过来，一个字没改（只换了 import）。
// 改这里之前必须知道：锁不占着库连接（见 github 的 lockerOver 注释）；PR 镜像写入按 GitHub 的 updated_at 防倒退。
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  type Db,
  idempotencyKeys,
  pullRequests,
  repos,
  tasks,
} from '@fleet-dao/db';
import {
  type IdempotencyStore,
  type Ledger,
  type Locker,
  type LockerOptions,
  lockerOver,
  type PrMirror,
} from '@fleet-dao/github';
import { and, eq, isNull, sql } from 'drizzle-orm';

export function pgIdempotencyStore(db: Db): IdempotencyStore {
  return {
    claim: (input, now) => claimIdempotencyKey(db, input, now),
    complete: (key, result, now) => completeIdempotencyKey(db, key, result, now),
    async release(key, heldClaimedAt) {
      const rows = await db
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.key, key),
            isNull(idempotencyKeys.completedAt),
            eq(idempotencyKeys.claimedAt, heldClaimedAt),
          ),
        )
        .returning({ key: idempotencyKeys.key });
      return rows.length > 0;
    },
    async peek(key) {
      const [row] = await db
        .select({
          claimedAt: idempotencyKeys.claimedAt,
          completedAt: idempotencyKeys.completedAt,
          result: idempotencyKeys.result,
        })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, key));
      return row ?? null;
    },
    async takeOver(key, seenClaimedAt, now) {
      const rows = await db
        .update(idempotencyKeys)
        .set({ claimedAt: now })
        .where(
          and(
            eq(idempotencyKeys.key, key),
            isNull(idempotencyKeys.completedAt),
            eq(idempotencyKeys.claimedAt, seenClaimedAt),
          ),
        )
        .returning({ key: idempotencyKeys.key });
      return rows.length > 0;
    },
  };
}

/** 跨工人的锁：逻辑在 github 的 lockerOver，这里只是拿 Postgres 的幂等账来造它。 */
export function pgLocker(db: Db, options: LockerOptions = {}): Locker {
  return lockerOver(pgIdempotencyStore(db), options);
}

export function pgLedger(db: Db): Ledger {
  const toMirror = (r: typeof pullRequests.$inferSelect): PrMirror => ({
    repoId: r.repoId,
    number: r.number,
    state: r.state,
    headRef: r.headRef,
    headSha: r.headSha,
    checks: r.checks,
    updatedAt: r.updatedAt,
    openedAt: r.openedAt,
    mergedAt: r.mergedAt,
    mergeSha: r.mergeSha,
    links: { issues: r.issueRefs, alerts: r.alertRefs },
  });
  return {
    idempotency: pgIdempotencyStore(db),
    async repoId(repo) {
      const [row] = await db
        .select({ id: repos.id })
        .from(repos)
        .where(
          and(
            sql`lower(${repos.owner}) = lower(${repo.owner})`,
            sql`lower(${repos.name}) = lower(${repo.name})`,
          ),
        );
      return row?.id ?? null;
    },
    async upsertPullRequest(row) {
      const written = await db
        .insert(pullRequests)
        .values({
          repoId: row.repoId,
          number: row.number,
          state: row.state,
          headRef: row.headRef,
          headSha: row.headSha,
          checks: row.checks ?? 'pending',
          updatedAt: row.updatedAt,
          syncedAt: new Date(),
          openedAt: row.openedAt ?? null,
          mergedAt: row.mergedAt ?? null,
          mergeSha: row.mergeSha ?? null,
          issueRefs: row.links?.issues ?? [],
          alertRefs: row.links?.alerts ?? [],
        })
        .onConflictDoUpdate({
          target: [pullRequests.repoId, pullRequests.number],
          set: {
            state: sql`excluded.state`,
            headRef: sql`excluded.head_ref`,
            headSha: sql`excluded.head_sha`,
            checks: row.checks
              ? sql`excluded.checks`
              : sql`case when ${pullRequests.headSha} = excluded.head_sha then ${pullRequests.checks} else 'pending'::pr_checks end`,
            updatedAt: sql`excluded.updated_at`,
            syncedAt: sql`excluded.synced_at`,
            // 这次没读到的（undefined）不改：旧值留着
            ...(row.openedAt === undefined ? {} : { openedAt: sql`excluded.opened_at` }),
            ...(row.mergedAt === undefined ? {} : { mergedAt: sql`excluded.merged_at` }),
            ...(row.mergeSha === undefined ? {} : { mergeSha: sql`excluded.merge_sha` }),
            ...(row.links === undefined
              ? {}
              : { issueRefs: sql`excluded.issue_refs`, alertRefs: sql`excluded.alert_refs` }),
          },
          setWhere: sql`${pullRequests.updatedAt} <= excluded.updated_at`,
        })
        .returning({ number: pullRequests.number });
      return written.length > 0 ? 'written' : 'stale';
    },
    async getPullRequest(repoId, number) {
      const [row] = await db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, number)));
      return row ? toMirror(row) : null;
    },
    async pullRequestsByHead(repoId, headSha) {
      const rows = await db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.headSha, headSha)));
      return rows.map(toMirror);
    },
    async setChecks(repoId, number, headSha, checks) {
      const rows = await db
        .update(pullRequests)
        .set({ checks, syncedAt: new Date() })
        .where(
          and(
            eq(pullRequests.repoId, repoId),
            eq(pullRequests.number, number),
            eq(pullRequests.headSha, headSha),
          ),
        )
        .returning({ number: pullRequests.number });
      return rows.length > 0;
    },
    async taskFor(repoId, issueNumber) {
      const [row] = await db
        .select({ id: tasks.id, state: tasks.state })
        .from(tasks)
        .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, issueNumber)));
      return row ?? null;
    },
  };
}
