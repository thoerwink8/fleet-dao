// 估算类的池的用量记录接真库（PGlite，real/quota-read.ts 的 sessionUsageSource）：Fusion 的会话和三段的一次性会话都进估算，
// 没记到花费的不拿 0 顶；runs 读不了明确报错，不拿 Fusion 那一半当全部（#758）。
import { randomUUID } from 'node:crypto';
import { sessionRuns, startRun } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionUsageSource } from '../../src/real/quota-read.ts';
import { addTask, MIN, NOW, world } from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
});

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);
const window = { poolId: 'claude-carpool', since: ago(60), until: NOW };

/** 拼车池上一次 Fusion 的会话：花了 0.4 美元。 */
async function fusionSession(taskId: string) {
  const id = randomUUID();
  await t.db.insert(sessionRuns).values({
    id,
    taskId,
    stage: 'execute',
    routeId: 'carpool',
    whyRoute: 'x',
    queuedAt: ago(40),
    runAsUser: 'fleet-agent-carpool',
    startedAt: ago(40),
    sessionId: `s-${id}`,
    outcome: 'ok',
    endedAt: ago(35),
    inputTokens: 500,
    costUsd: 0.4,
  });
}

describe('估算类的池的用量记录（sessionUsageSource 接真库）', () => {
  it('三段的一次性会话记下的 token、花费算进用量，和 Fusion 的会话一起；没记到花费的不进记录，不拿 0 顶', async () => {
    const { task } = await addTask(t.db);
    await fusionSession(task.id);
    await startRun(t.db, {
      segment: 'manual',
      model: 'opus-5.5',
      taskId: task.id,
      routeId: 'carpool',
      startedAt: ago(20),
      endedAt: ago(10),
      outcome: 'done',
      routeOutcome: 'ok',
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 30_000,
      costUsd: 2.5,
    });
    // 执行体没报花费的一次（比如半路被杀）：不进记录，估算按「下限」算，不当 0 美元
    await startRun(t.db, {
      segment: 'verify',
      model: 'opus-5.5',
      taskId: task.id,
      routeId: 'carpool',
      startedAt: ago(8),
      endedAt: ago(7),
      outcome: 'failed',
      routeOutcome: 'fail',
      inputTokens: 90,
    });
    // 别的池上的一次性会话不算
    await startRun(t.db, {
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'solo',
      startedAt: ago(5),
      endedAt: ago(4),
      outcome: 'done',
      routeOutcome: 'ok',
      costUsd: 9,
    });

    expect(await sessionUsageSource(t.db)(window)).toEqual([
      {
        poolId: 'claude-carpool',
        at: ago(40).toISOString(),
        modelId: 'opus-5.5',
        inputTokens: 500,
        costUsd: 0.4,
      },
      {
        poolId: 'claude-carpool',
        at: ago(20).toISOString(),
        modelId: 'opus-5.5',
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadTokens: 30_000,
        costUsd: 2.5,
      },
    ]);
  });

  it('【故意造出的失败】runs 读不了（把表挪开，查它就报错）：估算明确没读成，不拿 Fusion 那一半当全部', async () => {
    const { task } = await addTask(t.db);
    await fusionSession(task.id);
    await t.client.exec('alter table runs rename to runs_unreadable');
    try {
      const err = await sessionUsageSource(t.db)(window).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, 'runs 读不了却交回了用量记录').not.toBeNull();
      const messages: string[] = [];
      for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
      expect(messages.join('\n')).toContain('relation "runs" does not exist');
    } finally {
      await t.client.exec('alter table runs_unreadable rename to runs');
    }
  });
});
