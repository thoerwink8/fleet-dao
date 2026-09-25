// 防重复写：每个 GitHub 写操作带幂等键，账记在 Postgres 的 idempotency_keys（@fleet-dao/db），不放本机文件——
// 换机器、多个工人、从备份恢复后重放都认得出来（旧网关的账是每台机器一份的本地文件，docs/reference/github.md §0 第 7 条）。
//
// 流程（once）：占键 → 先回查远端有没有（按正文里的标记、按分支）→ 没有才写 → 记回执。
// - 占到键就开始续占用（回查、写都可能慢）；写之前再确认一次占用还在自己手里，不在就放弃这次写。
// - 写的时候断在回执上（maybeLanded）：键留着「写到一半」，下次重试先回查，找到就补账，找不到且占用已过期才重写（B1）。
// - 确定没写成（GitHub 明确拒了、回查就失败了）：放键，下次可以重新占。只放自己那一份，已经被别人接过去的不动。
// - 键由内容推出来（动作 + 目标 + 内容摘要）：同一件事重试一定是同一个键；给 issue 和给 PR 的同一组改动是两个键（B4）。
import { createHash } from 'node:crypto';
import {
  type ClaimResult,
  claimIdempotencyKey,
  completeIdempotencyKey,
  type Db,
  idempotencyKeys,
} from '@fleet-dao/db';
import { and, eq, isNull } from 'drizzle-orm';
import { GitHubError, isGitHubError, redact } from './errors.ts';

export type { ClaimResult };

/** 占用多久没续就当占着的人死了。续的间隔要远小于它：续不上几次也还来得及。 */
export const CLAIM_STALE_AFTER_MS = 120_000;
export const CLAIM_RENEW_EVERY_MS = 30_000;

export interface IdempotencyStore {
  claim(input: { key: string; action: string; target?: string }, now: Date): Promise<ClaimResult>;
  complete(key: string, result: unknown, now: Date): Promise<void>;
  /** 放掉占用：只在 claimedAt 还是 heldClaimedAt 时放（被别人接过去了就不动，不然会删掉别人的占用）。 */
  release(key: string, heldClaimedAt: Date): Promise<boolean>;
  /** 占着的人大概死了：把占用抢过来。只有 claimedAt 还是看到的那个时才成功（两个重试同时来只有一个抢得到）。 */
  takeOver(key: string, seenClaimedAt: Date, now: Date): Promise<boolean>;
  /** 只读：这个键的账（对账、认回声用）；没有返回 null。 */
  peek(key: string): Promise<{ claimedAt: Date; completedAt: Date | null; result: unknown } | null>;
}

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

/** 只给测试和不连库的场合用：进程一退账就没了。 */
export function memoryIdempotencyStore(): IdempotencyStore & {
  rows: Map<string, { action: string; claimedAt: Date; completedAt?: Date; result?: unknown }>;
} {
  const rows = new Map<string, { action: string; claimedAt: Date; completedAt?: Date; result?: unknown }>();
  return {
    rows,
    async claim(input, now) {
      const row = rows.get(input.key);
      if (!row) {
        rows.set(input.key, { action: input.action, claimedAt: now });
        return { status: 'claimed' };
      }
      if (row.completedAt) return { status: 'done', result: row.result, completedAt: row.completedAt };
      return { status: 'in-flight', claimedAt: row.claimedAt };
    },
    async complete(key, result, now) {
      const row = rows.get(key);
      if (!row || row.completedAt) throw new Error(`幂等键 ${key} 没被占着，或者已经完成过`);
      row.completedAt = now;
      row.result = JSON.parse(JSON.stringify(result ?? null));
    },
    async release(key, heldClaimedAt) {
      const row = rows.get(key);
      if (!row || row.completedAt || row.claimedAt.getTime() !== heldClaimedAt.getTime()) return false;
      rows.delete(key);
      return true;
    },
    async takeOver(key, seen, now) {
      const row = rows.get(key);
      if (!row || row.completedAt || row.claimedAt.getTime() !== seen.getTime()) return false;
      row.claimedAt = now;
      return true;
    },
    async peek(key) {
      const row = rows.get(key);
      return row
        ? { claimedAt: row.claimedAt, completedAt: row.completedAt ?? null, result: row.result }
        : null;
    },
  };
}

/** 键：gh:<动作>:<目标>[:<内容摘要>]。内容用稳定序列化取 sha256 前 16 位。 */
export function idempotencyKey(action: string, target: string, content?: unknown): string {
  if (content === undefined) return `gh:${action}:${target}`;
  return `gh:${action}:${target}:${digest(content)}`;
}

export function digest(content: unknown): string {
  return createHash('sha256').update(stableStringify(content)).digest('hex').slice(0, 16);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`;
}

export interface OnceSpec<T> {
  key: string;
  action: string;
  target: string;
  /** 远端是不是已经有了（按标记、分支……找）；有就返回它的回执。 */
  lookup: () => Promise<T | null>;
  /** 真去写。只放「写」这一个请求，回读自证放在 once 外面：回读失败不能被当成「没写成」而放键。 */
  write: () => Promise<T>;
  now: () => Date;
  /** 「写到一半」的占用超过这么久没续、远端又找不到，就当写的人死了，抢过来重写。默认 2 分钟。 */
  staleAfterMs?: number | undefined;
  /**
   * 占着的期间每隔这么久续一次（把 claimedAt 挪到现在），默认 30 秒。回查要翻页、写要排队，撞了限流还要等，
   * 等多久没有上限；只靠「占了多久」判死活，活着的一方会被重试抢走、同一条评论落两次。
   */
  renewEveryMs?: number | undefined;
}

export interface OnceResult<T> {
  value: T;
  /** true = 以前写成过（账上有或远端找到了），这次没写。 */
  replay: boolean;
}

export async function once<T>(store: IdempotencyStore, spec: OnceSpec<T>): Promise<OnceResult<T>> {
  const claimedAt = spec.now();
  const claim = await store.claim({ key: spec.key, action: spec.action, target: spec.target }, claimedAt);
  if (claim.status === 'done') return { value: claim.result as T, replay: true };

  if (claim.status === 'claimed') {
    // 占到了就开始续：回查也会慢（评论翻很多页、撞了限流在等）
    const lease = holdLease(store, spec, claimedAt);
    try {
      let found: T | null;
      try {
        found = await spec.lookup();
      } catch (err) {
        // 还没写过：放掉刚占的键，重试不用等占用过期
        await lease.release();
        throw err;
      }
      if (found !== null) {
        lease.stop();
        await record(store, spec, found);
        return { value: found, replay: true };
      }
      return await writeHolding(store, spec, lease);
    } finally {
      lease.stop();
    }
  }

  // 别处占着：先回查（可能写成了、只是账没记上），找不到且占用过期了才接过来
  const found = await spec.lookup();
  if (found !== null) {
    await record(store, spec, found);
    return { value: found, replay: true };
  }
  const age = spec.now().getTime() - claim.claimedAt.getTime();
  if (age < (spec.staleAfterMs ?? CLAIM_STALE_AFTER_MS)) {
    throw new GitHubError('IN_FLIGHT', `同一个写操作（${spec.action} ${spec.target}）别处正在做，稍后重试`, {
      retryable: true,
      details: { key: spec.key, claimedAt: claim.claimedAt.toISOString() },
    });
  }
  const takenAt = spec.now();
  if (!(await store.takeOver(spec.key, claim.claimedAt, takenAt))) {
    throw new GitHubError(
      'IN_FLIGHT',
      `同一个写操作（${spec.action} ${spec.target}）刚被别的重试抢走，稍后重试`,
      { retryable: true, details: { key: spec.key } },
    );
  }
  const lease = holdLease(store, spec, takenAt);
  try {
    return await writeHolding(store, spec, lease);
  } finally {
    lease.stop();
  }
}

/** 占着键去写：写之前确认占用还在自己手里（续约断过一阵，可能已被别的重试当成死了接过去）。 */
async function writeHolding<T>(
  store: IdempotencyStore,
  spec: OnceSpec<T>,
  lease: Lease,
): Promise<OnceResult<T>> {
  if (!(await lease.confirm())) {
    throw new GitHubError(
      'CLAIM_LOST',
      `${spec.action} ${spec.target}：占用已经被别的重试接过去了，这次不写（写了就是第二份）`,
      { retryable: true, details: { key: spec.key } },
    );
  }
  let value: T;
  try {
    value = await spec.write();
  } catch (err) {
    // 可能已经写成的，键留着让下次先回查；确定没写成的放键。
    if (!(isGitHubError(err) && err.maybeLanded)) await lease.release();
    throw err;
  }
  lease.stop();
  await record(store, spec, value);
  return { value, replay: false };
}

export interface Lease {
  /** 马上续一次（排在正在跑的那次后面），返回占用是不是还在自己手里。库连不上就抛。 */
  confirm(): Promise<boolean>;
  /** 停止续，放掉占用：只放自己那一份，已经被别人接过去的不动。返回放没放成。 */
  release(): Promise<boolean>;
  /** 只停止续（写成了、接着记回执）。 */
  stop(): void;
  /** 续的时候发现占用已经不在自己手里。 */
  readonly lost: boolean;
}

export interface LeaseSpec {
  key: string;
  now: () => Date;
  renewEveryMs?: number | undefined;
}

/**
 * 占着一个键的期间定时续（CAS：claimedAt 还是自己上次写的那个才续得上）。
 * 续不上分两种：库一时连不上（下一轮再试），和占用已经被别人接过去（记成 lost，之后不再续）。
 */
export function holdLease(store: IdempotencyStore, spec: LeaseSpec, since: Date): Lease {
  let current = since;
  let lost = false;
  let pending = false;
  let chain: Promise<unknown> = Promise.resolve();
  // 一次接一次地续：两次同时拿同一个旧时刻去比，后到的那次必然失败，会被错当成「被接走了」
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const renew = () =>
    serial(async () => {
      if (lost) return false;
      const next = spec.now();
      if (await store.takeOver(spec.key, current, next)) {
        current = next;
        return true;
      }
      lost = true;
      return false;
    });
  const timer = setInterval(() => {
    if (pending) return;
    pending = true;
    renew()
      .catch(() => undefined)
      .finally(() => {
        pending = false;
      });
  }, spec.renewEveryMs ?? CLAIM_RENEW_EVERY_MS);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  return {
    confirm: renew,
    async release() {
      stop();
      return serial(async () => (lost ? false : store.release(spec.key, current))).catch(() => false);
    },
    stop,
    get lost() {
      return lost;
    },
  };
}

async function record<T>(store: IdempotencyStore, spec: OnceSpec<T>, value: T): Promise<void> {
  try {
    await store.complete(spec.key, value, spec.now());
  } catch (err) {
    // 东西已经在 GitHub 上了，账没记上：报失败并附上落地的对象，下次重试会按标记找回来补账（不会再写一份）。
    throw new GitHubError(
      'LEDGER_FAILED',
      `${spec.action} ${spec.target} 已经写成，但幂等账没记上：${redact(err instanceof Error ? err.message : String(err))}`,
      { retryable: true, details: { key: spec.key, landed: value }, cause: err },
    );
  }
}
