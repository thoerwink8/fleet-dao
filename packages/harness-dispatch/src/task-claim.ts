// 新内核认领一张单（决定 0124 第五节 3「切换」，#3773 的另一半）：认领只有一处，就是旧库 `tasks` 那一行。
// 新内核取得一张单＝插行，或把「没人在做」的行（旧引擎还没开始、state = queued、executor = engine）改成 owner = harness，
// 全是条件更新；所有权令牌 `fencing` 由旧库的触发器在 owner、executor、claimed_by 变化时加一，写方改不了。
// 旧引擎的派出判法、本机领单、旧对账见到 owner = harness 一律不碰（#3773），所以这一步先于派工。
// 这里只声明用到的几列（不 import 旧包）；内核连的是同一个 `fleet` 库，表在 public schema。
import type { TaskRef } from '@fleet-dao/harness-contract';
import type { Db } from '@fleet-dao/harness-store';
import { and, eq, sql } from 'drizzle-orm';
import { bigint, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const taskState = pgEnum('task_state', [
  'queued',
  'triaging',
  'asking',
  'planning',
  'running',
  'merging',
  'done',
  'stopped',
  'failed',
  'stalled',
]);

const repos = pgTable('repos', {
  id: uuid('id').primaryKey(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
});

const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  repoId: uuid('repo_id').notNull(),
  issueNumber: integer('issue_number').notNull(),
  title: text('title').notNull(),
  rawRequest: text('raw_request').notNull(),
  requestedBy: text('requested_by').notNull(),
  state: taskState('state').notNull(),
  priority: integer('priority').notNull(),
  executor: text('executor').notNull(),
  owner: text('owner').notNull(),
  fencing: bigint('fencing', { mode: 'number' }).notNull(),
  doing: text('doing'),
  phase: text('phase'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
});

export const HARNESS_REQUESTER = 'harness';

export type AcquireResult =
  | { ok: true; taskId: string; fencing: number; created: boolean }
  | { ok: false; code: 'unknown_repo' | 'held'; why: string };

async function repoId(db: Db, slug: string): Promise<string | null> {
  const [owner, name] = slug.split('/');
  if (!owner || !name) return null;
  const [row] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(sql`lower(${repos.owner}) = lower(${owner})`, sql`lower(${repos.name}) = lower(${name})`));
  return row?.id ?? null;
}

/**
 * 取得这张单：没有行就插一行（owner = harness）；已经是新内核的原样回令牌（幂等）；旧系统的行只有「queued 且归引擎」才改，
 * 其余（旧引擎在做、本机领着、已有进度）一律不抢，回 held 和原因。整件事在一个事务里，行上加锁。
 */
export async function acquireTask(db: Db, ref: TaskRef, title: string): Promise<AcquireResult> {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const rid = await repoId(tx, ref.repo);
    if (!rid) return { ok: false, code: 'unknown_repo', why: `旧库里没有仓 ${ref.repo}` } as const;
    const [row] = await tx
      .select({
        id: tasks.id,
        state: tasks.state,
        executor: tasks.executor,
        owner: tasks.owner,
        fencing: tasks.fencing,
      })
      .from(tasks)
      .where(and(eq(tasks.repoId, rid), eq(tasks.issueNumber, ref.issue)))
      .for('update');
    if (row) {
      if (row.owner === 'harness') {
        return { ok: true, taskId: row.id, fencing: row.fencing, created: false } as const;
      }
      if (row.owner !== 'v1' || row.executor !== 'engine' || row.state !== 'queued') {
        return {
          ok: false,
          code: 'held',
          why: `旧系统手上有这张单（owner ${row.owner}，executor ${row.executor}，状态 ${row.state}），不抢`,
        } as const;
      }
      const [won] = await tx
        .update(tasks)
        .set({ owner: 'harness', state: 'running', doing: '新内核在做', phase: null, updatedAt: new Date() })
        .where(
          and(
            eq(tasks.id, row.id),
            eq(tasks.owner, 'v1'),
            eq(tasks.executor, 'engine'),
            eq(tasks.state, 'queued'),
          ),
        )
        .returning({ fencing: tasks.fencing });
      if (!won) return { ok: false, code: 'held', why: '同一刻被旧系统改了，不抢' } as const;
      return { ok: true, taskId: row.id, fencing: won.fencing, created: false } as const;
    }
    const [created] = await tx
      .insert(tasks)
      .values({
        repoId: rid,
        issueNumber: ref.issue,
        title,
        rawRequest: title,
        requestedBy: HARNESS_REQUESTER,
        state: 'running',
        priority: sql`(select coalesce(max(${tasks.priority}), 0) + 1 from ${tasks} where ${tasks.repoId} = ${rid})`,
        executor: 'engine',
        owner: 'harness',
        fencing: 0,
        doing: '新内核在做',
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: tasks.id, fencing: tasks.fencing });
    if (!created) return { ok: false, code: 'held', why: '同一刻旧系统建了这张单的行，不抢' } as const;
    return { ok: true, taskId: created.id, fencing: created.fencing, created: true } as const;
  });
}

/**
 * 这张单现在的所有权令牌（给 checkFencing 用）。行没了、或已不归新内核，抛错：读不到不当成对得上。
 * 归旧系统的单令牌也会变，但这里更明确，直接说不是新内核的。
 */
export async function currentFencing(db: Db, ref: TaskRef): Promise<number> {
  const rid = await repoId(db, ref.repo);
  if (!rid) throw new Error(`旧库里没有仓 ${ref.repo}，读不到 ${ref.repo}#${ref.issue} 的令牌`);
  const [row] = await db
    .select({ owner: tasks.owner, fencing: tasks.fencing })
    .from(tasks)
    .where(and(eq(tasks.repoId, rid), eq(tasks.issueNumber, ref.issue)));
  if (!row) throw new Error(`旧库里没有 ${ref.repo}#${ref.issue} 的任务行，读不到令牌`);
  // 不归新内核了：返回一个永远对不上的数，让 checkFencing 把外部动作丢进 dead
  return row.owner === 'harness' ? row.fencing : -1;
}

/**
 * 把单放回旧系统（切回的最后一步）：只有令牌对得上才改，对不上说明别人已经动过，回 false。
 * state 由切回的情形定：没做过的回 queued 让旧引擎重新拉；已有 PR 的回 stopped（旧引擎接管续这个 PR 或人处理）。
 */
export async function releaseTask(
  db: Db,
  ref: TaskRef,
  fencing: number,
  to: { state: 'queued' | 'stopped'; doing: string },
): Promise<boolean> {
  const rid = await repoId(db, ref.repo);
  if (!rid) throw new Error(`旧库里没有仓 ${ref.repo}`);
  const rows = await db
    .update(tasks)
    .set({ owner: 'v1', executor: 'engine', state: to.state, doing: to.doing, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.repoId, rid),
        eq(tasks.issueNumber, ref.issue),
        eq(tasks.owner, 'harness'),
        eq(tasks.fencing, fencing),
      ),
    )
    .returning({ id: tasks.id });
  return rows.length > 0;
}
