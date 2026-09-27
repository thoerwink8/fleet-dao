// 开 PR 前别家验证要的库：写这张单的会话用过哪几族、每一轮验证的记录（含 Lead 拿证据驳回的）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authorFamiliesOfTask,
  saveVerifyRound,
  type VerifyRoundRecord,
  verifyRoundsOfTask,
} from '../src/queries/verify.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, expectViolation, MIN, NOW } from './helpers.ts';

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

describe('每一轮验证的记录', () => {
  async function fixture() {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const run = await addRun(t.db, { taskId: task.id, routeId: 'kimi-r', stage: 'verify', ...started });
    const row: VerifyRoundRecord = {
      id: randomUUID(),
      taskId: task.id,
      round: 1,
      head: 'a'.repeat(40),
      runId: run.id,
      routeId: 'kimi-r',
      family: 'kimi',
      authorFamilies: ['claude'],
      criteria: ['过期的验证码登录不了', '有一条故意造出失败的测试'],
      report: { head: 'a'.repeat(40), results: [], findings: [] },
      verdict: 'block',
      invalidWhy: null,
      rebuttals: [],
      finalVerdict: 'block',
      reasons: ['安全：密钥写进日志（证据：log.ts）'],
      notes: [],
    };
    return { task, row };
  }

  it('作废的一轮：写原因、没有结论，交回的连 JSON 都不是也能记（空）', async () => {
    const { task, row } = await fixture();
    await saveVerifyRound(
      t.db,
      {
        ...row,
        verdict: 'invalid',
        invalidWhy: '审的不是送检的头',
        finalVerdict: null,
        report: null,
        reasons: [],
      },
      NOW,
    );
    expect(await verifyRoundsOfTask(t.db, task.id)).toMatchObject([
      { verdict: 'invalid', invalidWhy: '审的不是送检的头', finalVerdict: null, report: null },
    ]);
  });

  it('验证模型交回后写一次，Lead 驳回后再写一次：同一行，驳回和驳回之后的结论记上，开始的时刻不变', async () => {
    const { task, row } = await fixture();
    await saveVerifyRound(t.db, row, ago(5 * MIN));
    await saveVerifyRound(
      t.db,
      {
        ...row,
        rebuttals: [{ target: '密钥写进日志', evidence: 'log.ts 第 8 行打的是密钥编号不是值' }],
        finalVerdict: 'pass',
        reasons: [],
      },
      NOW,
    );
    const rows = await verifyRoundsOfTask(t.db, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: 'block',
      finalVerdict: 'pass',
      rebuttals: [{ target: '密钥写进日志', evidence: 'log.ts 第 8 行打的是密钥编号不是值' }],
      reasons: [],
      createdAt: ago(5 * MIN),
      updatedAt: NOW,
    });
  });

  it('同一次写重试（同一个 id、同样的内容）：还是一行', async () => {
    const { task, row } = await fixture();
    await saveVerifyRound(t.db, row, NOW);
    await saveVerifyRound(t.db, row, NOW);
    expect(await verifyRoundsOfTask(t.db, task.id)).toHaveLength(1);
  });

  it.each([
    ['作废却没写原因', { verdict: 'invalid' as const }, 'verify_rounds_invalid_shape'],
    ['没作废却写了作废原因', { invalidWhy: '审的不是送检的头' }, 'verify_rounds_invalid_shape'],
    [
      '作废的却有驳回之后的结论',
      { verdict: 'invalid' as const, invalidWhy: '同一族', finalVerdict: 'pass' as const },
      'verify_rounds_invalid_shape',
    ],
    ['没作废却没有结论', { finalVerdict: null }, 'verify_rounds_invalid_shape'],
    ['没作废、交回的却是空的', { report: null }, 'verify_rounds_invalid_shape'],
    [
      '验证模型说过，驳回之后却成了挡',
      { verdict: 'pass' as const, finalVerdict: 'block' as const },
      'verify_rounds_pass_stays_pass',
    ],
    ['挡住了却没写挡在哪', { reasons: [] }, 'verify_rounds_reasons_match'],
    ['驳回之后过了，却还留着挡的理由', { finalVerdict: 'pass' as const }, 'verify_rounds_reasons_match'],
    ['不知道作者是哪一族', { authorFamilies: [] }, 'verify_rounds_authors_known'],
    ['第 0 轮', { round: 0 }, 'verify_rounds_round_positive'],
  ])('【失败】%s → 库里拒收', async (_name, patch, constraint) => {
    const { row } = await fixture();
    await expectViolation(saveVerifyRound(t.db, { ...row, ...patch }, NOW), constraint);
  });
});
