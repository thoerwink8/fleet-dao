import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authorFamiliesOfTask } from '../src/queries/verify.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, MIN } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await addRoute(t.db, { id: 'claude-r', poolId: 'relay-a', modelId: 'opus-5.5' });
  await addRoute(t.db, { id: 'gpt-r', poolId: 'relay-a', modelId: 'gpt-5.6-luna', hostId: 'mirasim' });
  await addRoute(t.db, { id: 'kimi-r', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
  await addRoute(t.db, { id: 'grok-r', poolId: 'relay-b', modelId: 'grok-4.7', hostId: 'grok' });
});

const started = { startedAt: ago(20 * MIN) };

describe('写这张单的会话用过哪几族', () => {
  it('只算这张单上真起过的、会写东西的会话：审查、验证、没起来的、别的单上的都不算', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const other = await addTask(t.db, repo.id);
    await addRun(t.db, { taskId: task.id, routeId: 'claude-r', stage: 'execute', ...started });
    await addRun(t.db, { taskId: task.id, routeId: 'claude-r', stage: 'plan', ...started });
    await addRun(t.db, { taskId: task.id, routeId: 'gpt-r', stage: 'review', ...started });
    await addRun(t.db, { taskId: task.id, routeId: 'kimi-r', stage: 'verify', ...started });
    await addRun(t.db, { taskId: task.id, routeId: 'grok-r', stage: 'execute' });
    await addRun(t.db, { taskId: other.id, routeId: 'kimi-r', stage: 'execute', ...started });
    expect(await authorFamiliesOfTask(t.db, task.id)).toEqual(['claude']);
  });

  it('副手用了别家：两族都算作者（按字母排）', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await addRun(t.db, { taskId: task.id, routeId: 'kimi-r', stage: 'execute', ...started });
    await addRun(t.db, { taskId: task.id, routeId: 'claude-r', stage: 'plan', ...started });
    expect(await authorFamiliesOfTask(t.db, task.id)).toEqual(['claude', 'kimi']);
  });

  it('【失败】一个会话都没有：回空数组（调用方明确报错，不当成谁都能验）', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    expect(await authorFamiliesOfTask(t.db, task.id)).toEqual([]);
  });
});
