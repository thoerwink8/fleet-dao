// 动手战绩按模型算（model-track.ts，PLAN 3f）：一单记在第一段动手的模型名下，只数算路由账的段、到了终态的单、
// 第一段在窗口里开头的单；读不了照抛。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modelExecuteTracks, modelTierTracks } from '../src/queries/model-track.ts';
import { startRun } from '../src/queries/runs.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addTask, ago, catalog, DAY, HOUR, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await addRoute(t.db, { id: 'a-grok', poolId: 'relay-a', modelId: 'grok-4.7' });
  await addRoute(t.db, { id: 'b-ds', poolId: 'relay-b', modelId: 'deepseek-flash' });
});

const since = new Date(NOW.getTime() - 7 * DAY);

async function seg(
  taskId: string,
  routeId: string,
  startAgo: number,
  minutes: number,
  routeOutcome: 'ok' | 'fail' | 'neutral' = 'ok',
  segment: 'manual' | 'verify' = 'manual',
  tier?: 'fast' | 'medium' | 'heavyweight',
) {
  await startRun(t.db, {
    id: randomUUID(),
    segment,
    taskId,
    model: routeId === 'a-grok' ? 'grok-4.7' : 'deepseek-flash',
    routeId,
    startedAt: ago(startAgo),
    endedAt: ago(startAgo - minutes * MIN),
    outcome: routeOutcome === 'ok' ? 'done' : 'failed',
    routeOutcome,
    ...(tier ? { tier } : {}),
  });
}

describe('modelExecuteTracks', () => {
  it('一单记在第一段动手的模型名下；一段做成算一轮成；neutral、验收段不算；没到终态的不算、叫停的算没做成；窗口外开头的不算', async () => {
    const repo = await addRepo(t.db);
    // grok 一段做成（中间一段被切号记 neutral，不算）
    const a = await addTask(t.db, repo.id, { state: 'done' });
    await seg(a.id, 'a-grok', 10 * HOUR, 20);
    await seg(a.id, 'a-grok', 9 * HOUR, 5, 'neutral');
    await seg(a.id, 'b-ds', 8 * HOUR, 10, 'ok', 'verify');
    // deepseek 开头、两段失败后 grok 接手做成：记在 deepseek 名下，三段都算
    const b = await addTask(t.db, repo.id, { state: 'done' });
    await seg(b.id, 'b-ds', 20 * HOUR, 30, 'fail');
    await seg(b.id, 'b-ds', 19 * HOUR, 30, 'fail');
    await seg(b.id, 'a-grok', 18 * HOUR, 15);
    // deepseek 开头、最后失败
    const c = await addTask(t.db, repo.id, { state: 'failed' });
    await seg(c.id, 'b-ds', 30 * HOUR, 40, 'fail');
    // 还在跑的：不算；叫停的：算一单、没做成
    const d = await addTask(t.db, repo.id, { state: 'running' });
    await seg(d.id, 'a-grok', 5 * HOUR, 10);
    const e = await addTask(t.db, repo.id, { state: 'stopped' });
    await seg(e.id, 'a-grok', 5 * HOUR, 10);
    // 第一段在窗口外：整单不算（窗口里那段也不记到 grok 头上）
    const f = await addTask(t.db, repo.id, { state: 'done' });
    await seg(f.id, 'b-ds', 8 * DAY, 10, 'fail');
    await seg(f.id, 'a-grok', 2 * DAY, 10);

    const got = await modelExecuteTracks(t.db, since);
    expect(got).toEqual([
      { modelId: 'deepseek-flash', tasks: 2, done: 1, oneRound: 0, segments: 4, segmentMinutes: 115 },
      { modelId: 'grok-4.7', tasks: 2, done: 1, oneRound: 1, segments: 2, segmentMinutes: 30 },
    ]);
  });

  it('一段都没有：空表（不是读坏了）', async () => {
    expect(await modelExecuteTracks(t.db, since)).toEqual([]);
  });

  it('runs 读不了照抛，不当成没有战绩', async () => {
    await t.client.exec('alter table runs rename to runs_unreadable');
    try {
      await expect(modelExecuteTracks(t.db, since)).rejects.toThrow();
    } finally {
      await t.client.exec('alter table runs_unreadable rename to runs');
    }
  });
});

describe('modelTierTracks', () => {
  it('只算第一段；接手返工不记在第一个模型名下；同一模型 fast 和 heavy 分两行', async () => {
    const repo = await addRepo(t.db);
    // grok 快档一段做成（neutral、验收段不算进段数，分钟只算第一段那 20）
    const a = await addTask(t.db, repo.id, { state: 'done' });
    await seg(a.id, 'a-grok', 10 * HOUR, 20, 'ok', 'manual', 'fast');
    await seg(a.id, 'a-grok', 9 * HOUR, 5, 'neutral', 'manual', 'fast');
    await seg(a.id, 'b-ds', 8 * HOUR, 10, 'ok', 'verify', 'fast');
    // grok 主力档开头 20 分钟，deepseek 接手 30 分钟做成：只记 grok 第一段，deepseek 没有这一档
    const b = await addTask(t.db, repo.id, { state: 'done' });
    await seg(b.id, 'a-grok', 20 * HOUR, 20, 'fail', 'manual', 'heavyweight');
    await seg(b.id, 'b-ds', 18 * HOUR, 30, 'ok', 'manual', 'heavyweight');
    // grok 主力档一段失败
    const c = await addTask(t.db, repo.id, { state: 'failed' });
    await seg(c.id, 'a-grok', 6 * HOUR, 15, 'fail', 'manual', 'heavyweight');
    // deepseek 中档一段收了场、单叫停、没有 PR：没交付
    const d = await addTask(t.db, repo.id, { state: 'stopped' });
    await seg(d.id, 'b-ds', 5 * HOUR, 12, 'ok', 'manual', 'medium');
    // 没记档：整单不算
    const e = await addTask(t.db, repo.id, { state: 'done' });
    await seg(e.id, 'a-grok', 4 * HOUR, 10);
    // 第一段在窗口外：整单不算（窗口里那段也不记到 grok 头上）
    const f = await addTask(t.db, repo.id, { state: 'done' });
    await seg(f.id, 'b-ds', 8 * DAY, 10, 'fail', 'manual', 'fast');
    await seg(f.id, 'a-grok', 2 * DAY, 10, 'ok', 'manual', 'fast');

    const got = await modelTierTracks(t.db, since);
    expect(got).toEqual([
      {
        modelId: 'grok-4.7',
        tier: 'heavyweight',
        firstSegs: 2,
        onePass: 0,
        sentBack: 1,
        noDeliver: 0,
        notDone: 1,
        minutes: 35,
      },
      {
        modelId: 'deepseek-flash',
        tier: 'medium',
        firstSegs: 1,
        onePass: 0,
        sentBack: 0,
        noDeliver: 1,
        notDone: 0,
        minutes: 12,
      },
      {
        modelId: 'grok-4.7',
        tier: 'fast',
        firstSegs: 1,
        onePass: 1,
        sentBack: 0,
        noDeliver: 0,
        notDone: 0,
        minutes: 20,
      },
    ]);
  });

  it('一段都没有：空表（不是读坏了）', async () => {
    expect(await modelTierTracks(t.db, since)).toEqual([]);
  });

  it('runs 读不了照抛，不当成没有战绩', async () => {
    await t.client.exec('alter table runs rename to runs_unreadable');
    try {
      await expect(modelTierTracks(t.db, since)).rejects.toThrow();
    } finally {
      await t.client.exec('alter table runs_unreadable rename to runs');
    }
  });
});
