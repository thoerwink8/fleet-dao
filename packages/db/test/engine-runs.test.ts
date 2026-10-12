// 起会话要的两个事实查询：任务属于哪个仓、路由的池和执行方式。
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routeLaunchFacts, taskContext } from '../src/queries/engine.ts';
import { setPurposeModelEffort } from '../src/routing-order.ts';
import { pools, routingCatalog, routingPurposeModels } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addTask, catalog } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
});

describe('taskContext', () => {
  it('给出任务属于哪个仓、哪张 issue，连同仓的测试命令（repos.test_command）', async () => {
    const repo = await addRepo(t.db, 'shop');
    const task = await addTask(t.db, repo.id, { issueNumber: 42, title: '标题', rawRequest: '原话' });
    expect(await taskContext(t.db, task.id)).toEqual({
      taskId: task.id,
      issueNumber: 42,
      title: '标题',
      rawRequest: '原话',
      specDir: null,
      acceptance: [],
      repo: { id: repo.id, owner: 'acme', name: 'shop', defaultBranch: 'main', testCommand: 'pnpm check' },
    });
  });

  it('任务不在回 null', async () => {
    expect(await taskContext(t.db, randomUUID())).toBeNull();
  });
});

describe('routeLaunchFacts', () => {
  it('给出池、会话用户、执行方式、上游模型串', async () => {
    // relay-a、opus-5.5、claude-code 这一组合在 beforeEach 里已经被 r1 占了，另找 relay-b 避免撞 routes_pool_model_host_unique。
    await t.db
      .update(pools)
      .set({ runAsUser: 'fleet-agent-carpool', orgKind: 'solo' })
      .where(eq(pools.id, 'relay-b'));
    await addRoute(t.db, {
      id: 'r2',
      poolId: 'relay-b',
      modelId: 'opus-5.5',
      upstreamModel: 'claude-opus-5-5',
    });
    expect(await routeLaunchFacts(t.db, 'r2')).toEqual({
      routeId: 'r2',
      channelId: 'relay',
      poolId: 'relay-b',
      modelId: 'opus-5.5',
      hostId: 'claude-code',
      upstreamModel: 'claude-opus-5-5',
      runAsUser: 'fleet-agent-carpool',
      orgKind: 'solo',
      // 没挂进路由两层：没配档位
      effort: null,
      // 这条不是 Mirasim，名册没盖过执行体
      executor: null,
    });
  });

  it('思考档位只读用途表：没给用途是 null；改了用途表，下一次带上这个用途读到的就是新的；路由上的旧档不管', async () => {
    await t.db
      .insert(routingCatalog)
      .values({ modelId: 'opus-5.5', routeId: 'r1', position: 0, enabled: true, effort: 'low' });
    await t.db.insert(routingPurposeModels).values({ purpose: 'execute', modelId: 'opus-5.5', position: 0 });
    expect((await routeLaunchFacts(t.db, 'r1'))?.effort).toBeNull();
    expect((await routeLaunchFacts(t.db, 'r1', 'execute'))?.effort).toBeNull();
    expect(
      await setPurposeModelEffort(t.db, {
        purpose: 'execute',
        modelId: 'opus-5.5',
        effort: 'xhigh',
        version: 0,
      }),
    ).toMatchObject({ ok: true });
    expect((await routeLaunchFacts(t.db, 'r1', 'execute'))?.effort).toBe('xhigh');
    expect((await routeLaunchFacts(t.db, 'r1'))?.effort).toBeNull();
  });

  it('路由不在回 null', async () => {
    expect(await routeLaunchFacts(t.db, 'nope')).toBeNull();
  });
});
