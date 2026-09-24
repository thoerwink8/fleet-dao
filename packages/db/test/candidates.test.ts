import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stageCandidates, windowAppliesTo } from '../src/queries/candidates.ts';
import { bans, channels, models, pools, stagePolicies } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addTask,
  addWindow,
  ago,
  catalog,
  HOUR,
  later,
  MIN,
  NOW,
  setStageOrder,
} from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
});

const fresh = { reading: 'measured', readAt: ago(MIN) } as const;
const summary = async (stage: Parameters<typeof stageCandidates>[1]) =>
  (await stageCandidates(t.db, stage, { now: NOW })).candidates.map((c) => [c.routeId, c.blockers]);

describe('某阶段的候选路由', () => {
  it('按调度台排的顺序，不按 id 字母序', async () => {
    await addRoute(t.db, { id: 'z-first', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'a-second', poolId: 'relay-b', modelId: 'opus-5.5' });
    await setStageOrder(t.db, 'execute', ['z-first', 'a-second']);
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await addWindow(t.db, { poolId: 'relay-b', window: '7d', utilization: 0.1, ...fresh });
    expect(await summary('execute')).toEqual([
      ['z-first', []],
      ['a-second', []],
    ]);
  });

  it('阶段还没配顺序：候选为空并写明，不拿全部路由凑数', async () => {
    await t.db.delete(stagePolicies).where(eq(stagePolicies.stage, 'research'));
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    expect(await stageCandidates(t.db, 'research', { now: NOW })).toEqual({
      stage: 'research',
      configured: false,
      pinned: false,
      candidates: [],
    });
    // 种子给每个阶段建了空顺序：配了但没挂路由，同样为空。
    expect((await stageCandidates(t.db, 'review', { now: NOW })).candidates).toEqual([]);
  });

  it('被挡的路由不删，留在表里并写明每一条原因', async () => {
    await addRoute(t.db, { id: 'offline', poolId: 'relay-a', modelId: 'opus-5.5', alive: false });
    await addRoute(t.db, { id: 'retired', poolId: 'relay-a', modelId: 'opus-4.9' });
    await t.db
      .update(models)
      .set({ retiredAt: ago(HOUR) })
      .where(eq(models.id, 'opus-4.9'));
    await setStageOrder(t.db, 'execute', ['offline', 'retired']);
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    expect(await summary('execute')).toEqual([
      ['offline', ['offline']],
      ['retired', ['model-retired']],
    ]);
  });

  it('渠道关了、订阅过期都挡', async () => {
    await addRoute(t.db, { id: 'r-a', poolId: 'relay-a', modelId: 'opus-5.5' });
    await setStageOrder(t.db, 'execute', ['r-a']);
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await t.db.update(channels).set({ enabled: false }).where(eq(channels.id, 'relay'));
    await t.db
      .update(pools)
      .set({ expiresAt: ago(MIN) })
      .where(eq(pools.id, 'relay-a'));
    expect(await summary('execute')).toEqual([['r-a', ['channel-disabled', 'pool-expired']]]);
  });

  it('禁令：代码里的硬禁令（GPT 不做 UI、不用 Fable）库里没有也生效，再并上库里另加的', async () => {
    expect(await t.db.select().from(bans)).toEqual([]);
    await addRoute(t.db, { id: 'gpt', poolId: 'relay-a', modelId: 'gpt-5.6-luna', hostId: 'codex' });
    await addRoute(t.db, { id: 'fable51', poolId: 'relay-a', modelId: 'fable-5.1' });
    await addRoute(t.db, { id: 'fable52', poolId: 'relay-b', modelId: 'claude-fable-5.2' });
    await addRoute(t.db, { id: 'grok', poolId: 'relay-b', modelId: 'grok-4.7', hostId: 'grok' });
    await setStageOrder(t.db, 'ui', ['gpt', 'fable51', 'fable52', 'grok']);
    await setStageOrder(t.db, 'execute', ['gpt', 'grok']);
    await t.db.insert(bans).values({ family: 'grok', stage: 'ui', reason: '创始人另加：Grok 暂不做 UI' });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await addWindow(t.db, { poolId: 'relay-b', window: '7d', utilization: 0.1, ...fresh });
    const ui = await stageCandidates(t.db, 'ui', { now: NOW });
    expect(ui.candidates.map((c) => [c.routeId, c.blockers, c.banReasons])).toEqual([
      ['gpt', ['banned'], ['GPT 不做 UI 类活']],
      ['fable51', ['banned'], ['不用 Fable（出比 5.1 更高的版本之前）']],
      ['fable52', ['banned'], ['不用 Fable（出比 5.1 更高的版本之前）']],
      ['grok', ['banned'], ['创始人另加：Grok 暂不做 UI']],
    ]);
    expect(await summary('execute')).toEqual([
      ['gpt', []],
      ['grok', []],
    ]);
  });

  it('模型组窗口只卡组名对得上的模型：7d_claude 满了，同池的 Kimi 照常', async () => {
    await addRoute(t.db, { id: 'opus', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'k3', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
    await setStageOrder(t.db, 'execute', ['opus', 'k3']);
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', used: 285511, limit: 512600, ...fresh });
    await addWindow(t.db, {
      poolId: 'relay-a',
      window: '7d_model',
      scope: 'claude',
      used: 510000,
      limit: 512600,
      upstreamStatus: 'limit_reached',
      resetsAt: later(2 * 24 * HOUR),
      ...fresh,
    });
    const result = await stageCandidates(t.db, 'execute', { now: NOW });
    expect(result.candidates.map((c) => [c.routeId, c.quota, c.windows.length, c.blockers])).toEqual([
      ['opus', 'exhausted', 2, ['quota-exhausted']],
      ['k3', 'ok', 1, []],
    ]);
  });

  it('模型组名按族名或模型 id 匹配', () => {
    expect(windowAppliesTo('', { id: 'opus-5.5', family: 'claude' })).toBe(true);
    expect(windowAppliesTo('claude', { id: 'opus-5.5', family: 'claude' })).toBe(true);
    expect(windowAppliesTo('fable', { id: 'claude-fable-5.2', family: 'claude' })).toBe(true);
    expect(windowAppliesTo('fable', { id: 'opus-5.5', family: 'claude' })).toBe(false);
  });

  it('额度没读成（从没读过、读数过期）不挡，但排在读到了的后面，标 unknown', async () => {
    await t.db.insert(pools).values({ id: 'relay-c', channelId: 'relay', maxConcurrency: 1 });
    await addRoute(t.db, { id: 'never-read', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'stale', poolId: 'relay-b', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'fresh', poolId: 'relay-c', modelId: 'opus-5.5' });
    await setStageOrder(t.db, 'execute', ['never-read', 'stale', 'fresh']);
    await addWindow(t.db, {
      poolId: 'relay-b',
      window: '7d',
      utilization: 0.1,
      reading: 'measured',
      readAt: ago(3 * HOUR),
    });
    await addWindow(t.db, { poolId: 'relay-c', window: '7d', utilization: 0.1, ...fresh });
    const result = await stageCandidates(t.db, 'execute', { now: NOW });
    // 读到了的排前面；没读成的两条挪到后面，彼此仍按调度台的顺序。
    expect(result.candidates.map((c) => [c.routeId, c.position, c.quota, c.eligible])).toEqual([
      ['fresh', 2, 'ok', true],
      ['never-read', 0, 'unknown', true],
      ['stale', 1, 'unknown', true],
    ]);
  });

  it('并发按账号池算：同渠道的另一个池满了不影响这个池；不属于任何需求的会话也占名额', async () => {
    await addRoute(t.db, { id: 'a', poolId: 'relay-a', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'b', poolId: 'relay-b', modelId: 'opus-5.5' });
    await addRoute(t.db, { id: 'b-k3', poolId: 'relay-b', modelId: 'kimi-k3', hostId: 'mirasim' });
    await setStageOrder(t.db, 'execute', ['a', 'b']);
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
    await addWindow(t.db, { poolId: 'relay-b', window: '7d', utilization: 0.1, ...fresh });
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    // relay-b 上限 1：一场考新模型的会话（不属于任何需求、路由也不在本阶段）占着。
    await addRun(t.db, { taskId: null, stage: 'judge', routeId: 'b-k3', startedAt: ago(5 * MIN) });
    // relay-a 上限 2：只有一个在跑，一个已结束。
    await addRun(t.db, { taskId: task.id, routeId: 'a', startedAt: ago(5 * MIN) });
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'a',
      queuedAt: ago(60 * MIN),
      startedAt: ago(50 * MIN),
      endedAt: ago(40 * MIN),
      outcome: 'ok',
    });
    const result = await stageCandidates(t.db, 'execute', { now: NOW });
    expect(result.candidates.map((c) => [c.routeId, c.inFlight, c.maxConcurrency, c.blockers])).toEqual([
      ['a', 1, 2, []],
      ['b', 1, 1, ['no-slot']],
    ]);
  });

  it('钉住的顺序标出来', async () => {
    await t.db.update(stagePolicies).set({ pinned: true }).where(eq(stagePolicies.stage, 'plan'));
    expect((await stageCandidates(t.db, 'plan', { now: NOW })).pinned).toBe(true);
  });
});
