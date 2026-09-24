import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  toBan,
  toChannel,
  toModel,
  toPool,
  toProgressEvent,
  toQuotaWindow,
  toRepo,
  toSessionRun,
  toStagePolicy,
  toTask,
} from '../src/domain-map.ts';
import { getSubtasks, insertSubtasks } from '../src/queries/subtasks.ts';
import { STAGE_KINDS } from '../src/schema/enums.ts';
import {
  bans,
  channels,
  families,
  models,
  pools,
  progressEvents,
  quotaWindows,
  repos,
  routes,
  stagePolicies,
  users,
} from '../src/schema/index.ts';
import { SEED, seed } from '../src/seed.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, later, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

describe('种子', () => {
  it('跑两遍结果一样，第二遍一行都不新写', async () => {
    const first = await seed(t.db);
    expect(first).toEqual({
      families: SEED.families.length,
      models: SEED.models.length,
      channels: SEED.channels.length,
      stagePolicies: STAGE_KINDS.length,
    });
    expect(await seed(t.db)).toEqual({ families: 0, models: 0, channels: 0, stagePolicies: 0 });
    expect(await t.db.select().from(families)).toHaveLength(SEED.families.length);
  });

  it('不放任何账号信息：账号池、路由、成员、额度都是空的', async () => {
    await seed(t.db);
    for (const table of [pools, routes, users, quotaWindows, repos]) {
      expect(await t.db.select().from(table)).toEqual([]);
    }
  });

  it('种子里没有邮箱、IP、像密钥的长串', () => {
    const text = JSON.stringify(SEED);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{32,}/);
  });

  it('每个阶段都有一行（空顺序），按量渠道默认关着；全局禁令写在代码里，不进库', async () => {
    await seed(t.db);
    expect((await t.db.select().from(stagePolicies)).map((p) => p.stage).sort()).toEqual(
      [...STAGE_KINDS].sort(),
    );
    const metered = (await t.db.select().from(channels)).filter((c) => c.billing === 'metered');
    expect(metered.map((c) => c.enabled)).toEqual([false]);
    expect(await t.db.select().from(bans)).toEqual([]);
    // 库里另加的禁令照样能读成领域对象。
    await t.db.insert(bans).values({ family: 'grok', stage: 'ui', reason: '暂不做 UI' });
    expect((await t.db.select().from(bans)).map(toBan)).toEqual([
      { family: 'grok', stage: 'ui', reason: '暂不做 UI' },
    ]);
  });
});

describe('库里的行 → 领域对象', () => {
  it('时间变 ISO 字符串，空值变「不填」，账号级窗口没有 scope', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'opus', poolId: 'relay-a', modelId: 'opus-5.5' });
    const repo = await addRepo(t.db, 'shop');
    const task = await addTask(t.db, repo.id, { issueNumber: 12, createdAt: ago(MIN) });
    const run = await addRun(t.db, {
      taskId: task.id,
      routeId: 'opus',
      queuedAt: ago(10 * MIN),
      startedAt: ago(9 * MIN),
      endedAt: ago(MIN),
      outcome: 'ok',
      costUsd: 0.0116,
    });
    await t.db.insert(quotaWindows).values([
      {
        poolId: 'relay-a',
        window: '5h',
        utilization: 0.2,
        resetsAt: later(MIN),
        reading: 'measured',
        readAt: NOW,
      },
      {
        poolId: 'relay-a',
        window: '7d_model',
        scope: 'fable',
        upstreamStatus: 'limit_reached',
        reading: 'estimated',
        readAt: NOW,
      },
    ]);
    const [ev] = await t.db
      .insert(progressEvents)
      .values({ runId: run.id, at: NOW, kind: 'say', payload: '好了' })
      .returning();

    expect(toRepo((await t.db.select().from(repos))[0] as typeof repos.$inferSelect)).toEqual({
      id: repo.id,
      owner: 'acme',
      name: 'shop',
      defaultBranch: 'main',
      testCommand: 'pnpm check',
    });
    expect(toTask(task)).toEqual({
      id: task.id,
      repoId: repo.id,
      issueNumber: 12,
      title: task.title,
      rawRequest: task.rawRequest,
      requestedBy: 'founder-a',
      state: 'queued',
      priority: 10,
      acceptance: [],
      createdAt: ago(MIN).toISOString(),
    });
    expect(toSessionRun(run)).toEqual({
      id: run.id,
      taskId: task.id,
      stage: 'execute',
      routeId: 'opus',
      whyRoute: '写码阶段首选',
      queuedAt: ago(10 * MIN).toISOString(),
      startedAt: ago(9 * MIN).toISOString(),
      endedAt: ago(MIN).toISOString(),
      outcome: 'ok',
      costUsd: 0.0116,
    });
    const windows = (await t.db.select().from(quotaWindows)).map(toQuotaWindow);
    expect(windows).toEqual(
      expect.arrayContaining([
        {
          poolId: 'relay-a',
          window: '5h',
          utilization: 0.2,
          resetsAt: later(MIN).toISOString(),
          reading: 'measured',
          readAt: NOW.toISOString(),
        },
        {
          poolId: 'relay-a',
          window: '7d_model',
          scope: 'fable',
          upstreamStatus: 'limit_reached',
          reading: 'estimated',
          readAt: NOW.toISOString(),
        },
      ]),
    );
    expect(toProgressEvent(ev as typeof progressEvents.$inferSelect)).toEqual({
      runId: run.id,
      at: NOW.toISOString(),
      kind: 'say',
      payload: '好了',
    });
    const [pool] = await t.db.select().from(pools);
    expect(toPool(pool as typeof pools.$inferSelect)).toEqual({
      id: 'relay-a',
      channelId: 'relay',
      maxConcurrency: 2,
    });
    const [model] = (await t.db.select().from(models)).filter((m) => m.id === 'opus-5.5');
    expect(toModel(model as typeof models.$inferSelect)).toEqual({
      id: 'opus-5.5',
      family: 'claude',
      displayName: 'Opus 5.5',
    });
    const [relay] = (await t.db.select().from(channels)).filter((c) => c.id === 'relay');
    expect(toChannel(relay as typeof channels.$inferSelect)).toEqual({
      id: 'relay',
      name: '中转',
      billing: 'subscription',
      enabled: true,
    });
    const [policy] = (await t.db.select().from(stagePolicies)).filter((p) => p.stage === 'execute');
    expect(toStagePolicy(policy as typeof stagePolicies.$inferSelect, ['opus'])).toEqual({
      stage: 'execute',
      routeIds: ['opus'],
      pinned: false,
    });
  });

  it('子任务读回来带 dependsOn', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    await insertSubtasks(t.db, task.id, [
      { id: a, index: 0, title: '接口', touches: ['packages/api'], dependsOn: [] },
      {
        id: b,
        index: 1,
        title: '页面',
        touches: ['packages/web'],
        dependsOn: [a],
        prNumber: 32,
        waitingOn: '等接口合并',
      },
    ]);
    expect(await getSubtasks(t.db, task.id)).toEqual([
      {
        id: a,
        taskId: task.id,
        index: 0,
        title: '接口',
        touches: ['packages/api'],
        dependsOn: [],
        state: 'pending',
      },
      {
        id: b,
        taskId: task.id,
        index: 1,
        title: '页面',
        touches: ['packages/web'],
        dependsOn: [a],
        state: 'pending',
        prNumber: 32,
        waitingOn: '等接口合并',
      },
    ]);
  });
});
