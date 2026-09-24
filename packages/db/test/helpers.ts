// 测试夹具：每个测试一份内存库（createTestDb 克隆出来的），数据互不可见。
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { expect } from 'vitest';
import type { Db } from '../src/client.ts';
import {
  channels,
  models,
  pools,
  quotaWindows,
  repos,
  routes,
  sessionRuns,
  stagePolicies,
  stagePolicyRoutes,
  subtasks,
  tasks,
} from '../src/schema/index.ts';
import { seed } from '../src/seed.ts';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** 固定的「现在」，查询函数都从参数拿时钟，测试不看墙钟。 */
export const NOW = new Date('2026-09-25T12:00:00Z');
export const ago = (ms: number) => new Date(NOW.getTime() - ms);
export const later = (ms: number) => new Date(NOW.getTime() + ms);

/** 断言写入被某条约束拒掉（按约束名认，不按报错措辞认）。 */
export async function expectViolation(write: Promise<unknown>, constraint: string): Promise<void> {
  const err = await write.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `应当被 ${constraint} 拒掉，却写进去了`).not.toBeNull();
  const messages: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join('\n')).toContain(constraint);
}

/** 种子 + 一个渠道下的两个账号池 + 两个额外的模型（Fable 5.2 撞代码里的硬禁令，Opus 4.9 不撞）。 */
export async function catalog(db: Db) {
  await seed(db);
  await db.insert(channels).values({ id: 'relay', name: '中转', billing: 'subscription' });
  await db.insert(pools).values([
    { id: 'relay-a', channelId: 'relay', maxConcurrency: 2 },
    { id: 'relay-b', channelId: 'relay', maxConcurrency: 1 },
  ]);
  await db.insert(models).values([
    { id: 'claude-fable-5.2', family: 'claude', displayName: 'Fable 5.2' },
    { id: 'opus-4.9', family: 'claude', displayName: 'Opus 4.9' },
  ]);
  return { channelId: 'relay' };
}

export async function addRoute(
  db: Db,
  r: {
    id: string;
    poolId: string;
    modelId: string;
    /** 池所在的渠道；catalog 建的两个池都在 relay。 */
    channelId?: string;
    hostId?: (typeof routes.$inferInsert)['hostId'];
    alive?: boolean;
    upstreamModel?: string;
    upstreamAliases?: string[];
  },
) {
  await db.insert(routes).values({
    id: r.id,
    channelId: r.channelId ?? 'relay',
    poolId: r.poolId,
    modelId: r.modelId,
    hostId: r.hostId ?? 'claude-code',
    alive: r.alive ?? true,
    upstreamModel: r.upstreamModel ?? null,
    upstreamAliases: r.upstreamAliases ?? [],
  });
}

export async function setStageOrder(
  db: Db,
  stage: (typeof stagePolicies.$inferInsert)['stage'],
  routeIds: string[],
) {
  await db.insert(stagePolicies).values({ stage }).onConflictDoNothing();
  if (routeIds.length > 0) {
    await db
      .insert(stagePolicyRoutes)
      .values(routeIds.map((routeId, position) => ({ stage, routeId, position })));
  }
}

export async function addRepo(db: Db, name = `repo-${randomUUID().slice(0, 8)}`) {
  const [repo] = await db
    .insert(repos)
    .values({ owner: 'acme', name, testCommand: 'pnpm check' })
    .returning();
  if (!repo) throw new Error('repo 没写进去');
  return repo;
}

export async function addTask(db: Db, repoId: string, over: Partial<typeof tasks.$inferInsert> = {}) {
  const [task] = await db
    .insert(tasks)
    .values({
      repoId,
      issueNumber: over.issueNumber ?? Math.floor(Math.random() * 1e6) + 1,
      title: '给登录页加验证码',
      rawRequest: '登录页加一个手机验证码',
      requestedBy: 'founder-a',
      priority: 10,
      createdAt: ago(10 * HOUR),
      ...over,
    })
    .returning();
  if (!task) throw new Error('task 没写进去');
  return task;
}

export async function addSubtask(db: Db, taskId: string, over: Partial<typeof subtasks.$inferInsert> = {}) {
  const [row] = await db
    .insert(subtasks)
    .values({ taskId, index: 0, title: '写验证码接口', touches: ['packages/api/src/login.ts'], ...over })
    .returning();
  if (!row) throw new Error('subtask 没写进去');
  return row;
}

export async function addRun(
  db: Db,
  over: Partial<typeof sessionRuns.$inferInsert> & { taskId: string | null; routeId: string },
) {
  const [row] = await db
    .insert(sessionRuns)
    .values({ stage: 'execute', whyRoute: '写码阶段首选', queuedAt: ago(30 * MIN), ...over })
    .returning();
  if (!row) throw new Error('run 没写进去');
  return row;
}

type WindowFixture = Omit<typeof quotaWindows.$inferInsert, 'label' | 'unit' | 'source'> &
  Partial<Pick<typeof quotaWindows.$inferInsert, 'label' | 'unit' | 'source'>>;

/**
 * 直接插一行额度窗（绕开 savePoolQuota，好一行行造读数），并把池的最近读成时刻推到这行的读数时刻。
 * 没写的原名按「窗口类型_组名」拼，单位默认百分比，读法记 test。
 */
export async function addWindow(db: Db, w: WindowFixture) {
  await db.insert(quotaWindows).values(windowRow(w));
  await db
    .update(pools)
    .set({ lastReadOkAt: w.readAt })
    .where(and(eq(pools.id, w.poolId), or(isNull(pools.lastReadOkAt), lt(pools.lastReadOkAt, w.readAt))));
}

export function windowRow(w: WindowFixture): typeof quotaWindows.$inferInsert {
  return {
    label: w.scope ? `${w.window}_${w.scope}` : w.window,
    unit: 'percent',
    source: 'test',
    ...w,
  };
}
