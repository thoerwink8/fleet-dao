// 这个包在库里读写的东西：幂等账、PR 镜像（pull_requests）、按 owner/name 找仓、按 issue 号找需求。
// 表结构在 @fleet-dao/db；这里只放 GitHub 这一块要用的几条查询（以后别的包也要用，再挪进 db 包的 queries）。
// 驾驶舱、fleet done 的核实都只读镜像、不直接查 GitHub，所以镜像写错了人看到的就是错的：写入按 GitHub 的 updated_at 防倒退。
import { type Db, pullRequests, repos, tasks } from '@fleet-dao/db';
import { and, eq, sql } from 'drizzle-orm';
import { type Logger, type RepoRef, silentLogger } from './client.ts';
import { type Locker, memoryLocker } from './deps.ts';
import { GitHubError } from './errors.ts';
import {
  CLAIM_STALE_AFTER_MS,
  holdLease,
  type IdempotencyStore,
  type Lease,
  memoryIdempotencyStore,
  pgIdempotencyStore,
} from './idempotency.ts';

export interface PgLockerOptions {
  now?: () => Date;
  /** 等锁时两次尝试之间怎么睡（测试给假的）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 持锁的超过这么久没续就当它死了、接过来。默认 2 分钟，和防重复写的占用一样。 */
  staleAfterMs?: number;
  renewEveryMs?: number;
  log?: Logger;
}

/**
 * 跨工人的锁：锁是幂等账里的一行（action=github.lock，键 gh:lock:<名字>），持锁期间定时续，用完删掉。
 * 改这里之前必须知道：锁不占着库连接。持锁的 fn 里是几次 HTTP（秒到分钟级），还要查库（幂等账、回声）；
 * 要是像事务级 advisory lock 那样一直占着一条连接，fn 查库得再借一条，同时等锁、持锁的一多到连接池上限，
 * 就全在等彼此（PGlite 只有一条连接，一把锁就卡死）。
 * 代价：持锁的工人死了，别人要等它的占用过期（staleAfterMs）才接得过去。同一个进程里抢同一个键的先在进程内排队，不去库里轮询。
 */
export function pgLocker(db: Db, options: PgLockerOptions = {}): Locker {
  const store = pgIdempotencyStore(db);
  const local = memoryLocker();
  const o = {
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    staleAfterMs: options.staleAfterMs ?? CLAIM_STALE_AFTER_MS,
    renewEveryMs: options.renewEveryMs,
    log: options.log ?? silentLogger,
  };
  return {
    withLock: (name, fn) =>
      local.withLock(name, async () => {
        const key = `gh:lock:${name}`;
        const lease = await acquireLock(store, key, name, o);
        try {
          return await fn();
        } finally {
          if (!(await lease.release())) {
            o.log.error('锁在持有期间被别的工人当成过期接走了：这段期间可能有两个人同时在做', { lock: name });
          }
        }
      }),
  };
}

async function acquireLock(
  store: IdempotencyStore,
  key: string,
  name: string,
  o: Required<Omit<PgLockerOptions, 'renewEveryMs'>> & { renewEveryMs: number | undefined },
): Promise<Lease> {
  const lease = (since: Date) => holdLease(store, { key, now: o.now, renewEveryMs: o.renewEveryMs }, since);
  for (let attempt = 0; ; attempt += 1) {
    const at = o.now();
    const claim = await store.claim({ key, action: 'github.lock', target: name }, at);
    if (claim.status === 'claimed') return lease(at);
    if (claim.status === 'done') {
      throw new GitHubError(
        'LOCK_CORRUPT',
        `锁 ${name} 那一行被记成了「已完成」：锁从不完成，是账写错了，要人看一眼（删掉 ${key} 那一行即可）`,
        { details: { key } },
      );
    }
    if (o.now().getTime() - claim.claimedAt.getTime() >= o.staleAfterMs) {
      const takenAt = o.now();
      if (await store.takeOver(key, claim.claimedAt, takenAt)) {
        o.log.warn('接过了一把过期没续的锁：上一个持锁的多半死了', {
          lock: name,
          lastRenewedAt: claim.claimedAt.toISOString(),
        });
        return lease(takenAt);
      }
    }
    await o.sleep(Math.min(2_000, 50 * 2 ** Math.min(attempt, 6)));
  }
}

export type PrState = 'open' | 'closed' | 'merged';
export type PrChecks = 'success' | 'failure' | 'pending' | 'none';

export interface PrMirror {
  repoId: string;
  number: number;
  state: PrState;
  headRef: string;
  headSha: string;
  checks: PrChecks;
  /** GitHub 上这条 PR 的最后更新时间。 */
  updatedAt: Date;
}

export interface Ledger {
  idempotency: IdempotencyStore;
  /** 本系统管的仓在库里的编号；不归本系统管返回 null。 */
  repoId(repo: RepoRef): Promise<string | null>;
  /**
   * 写 PR 镜像。GitHub 的 updated_at 比库里旧就不写（事件乱序、补收晚到），返回 stale。
   * head 变了而没给 checks：CI 汇总重置成 pending（旧 head 的结论不算新 head 的）。
   */
  upsertPullRequest(row: Omit<PrMirror, 'checks'> & { checks?: PrChecks }): Promise<'written' | 'stale'>;
  getPullRequest(repoId: string, number: number): Promise<PrMirror | null>;
  pullRequestsByHead(repoId: string, headSha: string): Promise<PrMirror[]>;
  /** 只在 head 还是这个 sha 时改 CI 汇总（换了 head 的结论不写到新 head 上）。 */
  setChecks(repoId: string, number: number, headSha: string, checks: PrChecks): Promise<boolean>;
  /** 这张 issue 有没有对应的需求（有需求 = 工作流起过）。 */
  taskFor(repoId: string, issueNumber: number): Promise<{ id: string; state: string } | null>;
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

/** 不连库的实现：测试、以及真机验收时不想碰生产库的场合。 */
export function memoryLedger(init: { repos?: (RepoRef & { id: string })[] } = {}): Ledger & {
  prs: Map<string, PrMirror>;
  tasks: Map<string, { id: string; state: string }>;
} {
  const prs = new Map<string, PrMirror>();
  const taskRows = new Map<string, { id: string; state: string }>();
  const repoRows = init.repos ?? [];
  const k = (repoId: string, n: number) => `${repoId}#${n}`;
  return {
    prs,
    tasks: taskRows,
    idempotency: memoryIdempotencyStore(),
    async repoId(repo) {
      const hit = repoRows.find(
        (r) =>
          r.owner.toLowerCase() === repo.owner.toLowerCase() &&
          r.name.toLowerCase() === repo.name.toLowerCase(),
      );
      return hit?.id ?? null;
    },
    async upsertPullRequest(row) {
      const old = prs.get(k(row.repoId, row.number));
      if (old && old.updatedAt.getTime() > row.updatedAt.getTime()) return 'stale';
      const checks = row.checks ?? (old && old.headSha === row.headSha ? old.checks : 'pending');
      prs.set(k(row.repoId, row.number), { ...row, checks });
      return 'written';
    },
    async getPullRequest(repoId, number) {
      return prs.get(k(repoId, number)) ?? null;
    },
    async pullRequestsByHead(repoId, headSha) {
      return [...prs.values()].filter((p) => p.repoId === repoId && p.headSha === headSha);
    },
    async setChecks(repoId, number, headSha, checks) {
      const row = prs.get(k(repoId, number));
      if (!row || row.headSha !== headSha) return false;
      row.checks = checks;
      return true;
    },
    async taskFor(repoId, issueNumber) {
      return taskRows.get(k(repoId, issueNumber)) ?? null;
    },
  };
}
