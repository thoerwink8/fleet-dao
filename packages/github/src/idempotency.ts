// 防重复写：每个 GitHub 写操作带幂等键，账记在 Postgres 的 idempotency_keys（@fleet-dao/db），不放本机文件——
// 换机器、多个工人、从备份恢复后重放都认得出来（旧网关的账是每台机器一份的本地文件，docs/reference/github.md §0 第 7 条）。
//
// 流程（once）：占键 → 先回查远端有没有（按正文里的标记、按分支）→ 没有才写 → 记回执。
// - 写的时候断在回执上（maybeLanded）：键留着「写到一半」，下次重试先回查，找到就补账，找不到且占用已过期才重写（B1）。
// - 确定没写成（GitHub 明确拒了）：放键，下次可以重新占。
// - 键由内容推出来（动作 + 目标 + 内容摘要）：同一件事重试一定是同一个键；给 issue 和给 PR 的同一组改动是两个键（B4）。
import { createHash } from 'node:crypto';
import {
  type ClaimResult,
  claimIdempotencyKey,
  completeIdempotencyKey,
  type Db,
  idempotencyKeys,
  releaseIdempotencyKey,
} from '@fleet-dao/db';
import { and, eq, isNull } from 'drizzle-orm';
import { GitHubError, isGitHubError, redact } from './errors.ts';

export type { ClaimResult };

export interface IdempotencyStore {
  claim(input: { key: string; action: string; target?: string }, now: Date): Promise<ClaimResult>;
  complete(key: string, result: unknown, now: Date): Promise<void>;
  release(key: string): Promise<boolean>;
  /** 占着的人大概死了：把占用抢过来。只有 claimedAt 还是看到的那个时才成功（两个重试同时来只有一个抢得到）。 */
  takeOver(key: string, seenClaimedAt: Date, now: Date): Promise<boolean>;
}

export function pgIdempotencyStore(db: Db): IdempotencyStore {
  return {
    claim: (input, now) => claimIdempotencyKey(db, input, now),
    complete: (key, result, now) => completeIdempotencyKey(db, key, result, now),
    release: (key) => releaseIdempotencyKey(db, key),
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
    async release(key) {
      const row = rows.get(key);
      if (!row || row.completedAt) return false;
      rows.delete(key);
      return true;
    },
    async takeOver(key, seen, now) {
      const row = rows.get(key);
      if (!row || row.completedAt || row.claimedAt.getTime() !== seen.getTime()) return false;
      row.claimedAt = now;
      return true;
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
  /** 「写到一半」的占用超过这么久、远端又找不到，就当写的人死了，抢过来重写。默认 2 分钟。 */
  staleAfterMs?: number;
}

export interface OnceResult<T> {
  value: T;
  /** true = 以前写成过（账上有或远端找到了），这次没写。 */
  replay: boolean;
}

export async function once<T>(store: IdempotencyStore, spec: OnceSpec<T>): Promise<OnceResult<T>> {
  const claim = await store.claim({ key: spec.key, action: spec.action, target: spec.target }, spec.now());
  if (claim.status === 'done') return { value: claim.result as T, replay: true };

  const found = await spec.lookup();
  if (found !== null) {
    await record(store, spec, found);
    return { value: found, replay: true };
  }
  if (claim.status === 'in-flight') {
    const age = spec.now().getTime() - claim.claimedAt.getTime();
    if (age < (spec.staleAfterMs ?? 120_000)) {
      throw new GitHubError(
        'IN_FLIGHT',
        `同一个写操作（${spec.action} ${spec.target}）别处正在做，稍后重试`,
        {
          retryable: true,
          details: { key: spec.key, claimedAt: claim.claimedAt.toISOString() },
        },
      );
    }
    if (!(await store.takeOver(spec.key, claim.claimedAt, spec.now()))) {
      throw new GitHubError(
        'IN_FLIGHT',
        `同一个写操作（${spec.action} ${spec.target}）刚被别的重试抢走，稍后重试`,
        {
          retryable: true,
          details: { key: spec.key },
        },
      );
    }
  }

  let value: T;
  try {
    value = await spec.write();
  } catch (err) {
    // 可能已经写成的，键留着让下次先回查；确定没写成的放键。
    if (!(isGitHubError(err) && err.maybeLanded)) await store.release(spec.key).catch(() => false);
    throw err;
  }
  await record(store, spec, value);
  return { value, replay: false };
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
