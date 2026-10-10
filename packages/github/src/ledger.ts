// 这个包要用的账的形状：幂等账、PR 镜像（pull_requests）、按 owner/name 找仓、按 issue 号找需求，和不连库的内存实现、跨工人的锁的逻辑。
// 这个包是纯 GitHub API 包，不依赖数据库（#901 ⑤）：Postgres 的实现（pgLedger、pgLocker、pgIdempotencyStore）在 @fleet-dao/store 的
// github-pg.ts，表结构在 @fleet-dao/db。packages/conventions/test/package-layers.test.ts 钉住「github 不许依赖 db、store」。
// 驾驶舱、fleet done 的核实都只读镜像、不直接查 GitHub，所以镜像写错了人看到的就是错的：写入按 GitHub 的 updated_at 防倒退
// （Postgres 版和内存版都要照这条）。
import { sleep } from '@fleet-dao/shared/util';
import { type Logger, type RepoRef, silentLogger } from './client.ts';
import { type Locker, memoryLocker } from './deps.ts';
import { GitHubError } from './errors.ts';
import {
  CLAIM_STALE_AFTER_MS,
  holdLease,
  type IdempotencyStore,
  type Lease,
  memoryIdempotencyStore,
} from './idempotency.ts';

export interface LockerOptions {
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
 * 逻辑只依赖幂等账这个接口（账存在哪——Postgres、内存——它不知道），所以和库无关。
 * 改这里之前必须知道：锁不占着库连接。持锁的 fn 里是几次 HTTP（秒到分钟级），还要查库（幂等账、回声）；
 * 要是像事务级 advisory lock 那样一直占着一条连接，fn 查库得再借一条，同时等锁、持锁的一多到连接池上限，
 * 就全在等彼此（PGlite 只有一条连接，一把锁就卡死）。
 * 代价：持锁的工人死了，别人要等它的占用过期（staleAfterMs）才接得过去。同一个进程里抢同一个键的先在进程内排队，不去库里轮询。
 */
export function lockerOver(store: IdempotencyStore, options: LockerOptions = {}): Locker {
  const local = memoryLocker();
  const o = {
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? sleep,
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
  o: Required<Omit<LockerOptions, 'renewEveryMs'>> & { renewEveryMs: number | undefined },
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
  /**
   * 下面几样给「提醒谁在处理」现算用（design 15.3）：事件里带了才给；不给（undefined）= 这次没读到，库里旧值留着，
   * 不拿空顶（审计补合并那一路只有列表里的几样）。
   */
  openedAt?: Date | null | undefined;
  mergedAt?: Date | null | undefined;
  mergeSha?: string | null | undefined;
  /** GitHub 上的 PR 标题；这次没读到（undefined）库里旧值留着。 */
  title?: string | null | undefined;
  /** 正文挂的单（需求栏、关单词）和「修提醒」栏写的提醒（@fleet-dao/conventions 的 prLinks）。 */
  links?: { issues: number[]; alerts: string[] } | undefined;
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
      // 这次没读到的（undefined）不改：旧值留着（和 Postgres 版一样）
      prs.set(k(row.repoId, row.number), {
        ...row,
        checks,
        openedAt: row.openedAt === undefined ? (old?.openedAt ?? null) : row.openedAt,
        mergedAt: row.mergedAt === undefined ? (old?.mergedAt ?? null) : row.mergedAt,
        mergeSha: row.mergeSha === undefined ? (old?.mergeSha ?? null) : row.mergeSha,
        title: row.title === undefined ? (old?.title ?? null) : row.title,
        links: row.links === undefined ? old?.links : row.links,
      });
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
