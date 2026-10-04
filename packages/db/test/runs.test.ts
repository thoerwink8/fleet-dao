// runs 表（#555-3，#599）：三段每次跑一次的流水账。
// 本切片 verify 那一端先落地：saveVerifyRound 同一次写入两头都落（verify_rounds 记细节、runs 记流水，同一根 id）。
// 老行（只有 verify_rounds、没 runs 流水的）由 verifyRoundsOfTask 照原形状返回；runs 流水的专字（token、花费、真起止）
// 由 #556-4/-5/-6 装上真 RunsWriter 后真流水时刻补写。
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeOpenRuns, getRun, listOpenRuns, runsOfTask, startRun } from '../src/queries/runs.ts';
import { saveVerifyRound, type VerifyRoundRecord, verifyRoundsOfTask } from '../src/queries/verify.ts';
import { runs, verifyRounds } from '../src/schema/index.ts';
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
  await addRoute(t.db, { id: 'kimi-r', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
});

const started = { startedAt: ago(20 * MIN) };

async function fixture(task?: { id: string }) {
  const realTask = task ?? (await addTask(t.db, (await addRepo(t.db)).id));
  const run = await addRun(t.db, { taskId: realTask.id, routeId: 'kimi-r', stage: 'verify', ...started });
  const row: VerifyRoundRecord = {
    id: randomUUID(),
    taskId: realTask.id,
    round: 1,
    head: 'a'.repeat(40),
    runId: run.id,
    routeId: 'kimi-r',
    family: 'kimi',
    authorFamilies: ['claude'],
    criteria: ['过期的验证码登录不了'],
    report: { head: 'a'.repeat(40), results: [], findings: [] },
    verdict: 'pass',
    invalidWhy: null,
    rebuttals: [],
    finalVerdict: 'pass',
    reasons: [],
    notes: [],
  };
  return { task: realTask, run, row };
}

describe('runs 表本身的约束', () => {
  async function insertRun(over: Partial<typeof runs.$inferInsert>) {
    await t.db.insert(runs).values({
      segment: 'verify',
      model: 'opus-5.5',
      startedAt: ago(10 * MIN),
      ...over,
    });
  }

  it('正常一行：读不到的字段（token、costUsd、memoryPeakMb、pr、branch）= NULL，不是 0', async () => {
    const id = randomUUID();
    await insertRun({ id, endedAt: NOW, outcome: 'done' });
    const [row] = await t.db.select().from(runs).where(eq(runs.id, id));
    expect(row).toMatchObject({
      id,
      segment: 'verify',
      model: 'opus-5.5',
      channel: null,
      issueNumber: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      memoryPeakMb: null,
      prNumber: null,
      branch: null,
      workflowId: null,
      temporalRunId: null,
      retryOf: null,
    });
    expect(row?.endedAt).toEqual(NOW);
    expect(row?.outcome).toBe('done');
  });

  it('派工档：照 tier.ts 的三档收，没记就是 NULL', async () => {
    const id = randomUUID();
    await insertRun({ id, segment: 'manual', tier: 'heavyweight', endedAt: NOW, outcome: 'done' });
    const blank = randomUUID();
    await insertRun({ id: blank, endedAt: NOW, outcome: 'done' });
    const rows = await t.db.select({ id: runs.id, tier: runs.tier }).from(runs);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.tier]))).toEqual({
      [id]: 'heavyweight',
      [blank]: null,
    });
  });

  it('【失败】派工档写了 tier.ts 之外的字（「主力」「cold」）：库拒收（runs_tier_known）', async () => {
    for (const tier of ['主力', 'cold', 'Fast']) {
      await expectViolation(
        insertRun({ segment: 'manual', tier: tier as 'fast', endedAt: NOW, outcome: 'done' }),
        'runs_tier_known',
      );
    }
  });

  it('【失败】segment 写不在 scope|manual|verify 里的值：库拒收（runs_segment_known）', async () => {
    await expectViolation(
      insertRun({ segment: 'fusion-stage' as 'verify', endedAt: NOW, outcome: 'done' }),
      'runs_segment_known',
    );
  });

  it('【失败】outcome 写了别的字：库拒收（runs_outcome_known）', async () => {
    await expectViolation(insertRun({ endedAt: NOW, outcome: 'oops' as 'done' }), 'runs_outcome_known');
  });

  it('算不算路由的账（#758）：收场的行收 ok / fail / neutral，没写就是 NULL', async () => {
    const ids = { ok: randomUUID(), fail: randomUUID(), neutral: randomUUID(), blank: randomUUID() };
    await insertRun({ id: ids.ok, endedAt: NOW, outcome: 'done', routeOutcome: 'ok' });
    await insertRun({ id: ids.fail, endedAt: NOW, outcome: 'failed', routeOutcome: 'fail' });
    await insertRun({ id: ids.neutral, endedAt: NOW, outcome: 'org_switch', routeOutcome: 'neutral' });
    await insertRun({ id: ids.blank, endedAt: NOW, outcome: 'done' });
    const rows = await t.db.select({ id: runs.id, routeOutcome: runs.routeOutcome }).from(runs);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.routeOutcome]))).toEqual({
      [ids.ok]: 'ok',
      [ids.fail]: 'fail',
      [ids.neutral]: 'neutral',
      [ids.blank]: null,
    });
  });

  it('【失败】算不算路由的账写了别的字：库拒收（runs_route_outcome_known）', async () => {
    await expectViolation(
      insertRun({ endedAt: NOW, outcome: 'failed', routeOutcome: 'bad' as 'fail' }),
      'runs_route_outcome_known',
    );
  });

  it('【失败】还在跑的行就写了算不算路由的账：库拒收（runs_route_outcome_after_end），结论只在收场时下', async () => {
    await expectViolation(insertRun({ routeOutcome: 'fail' }), 'runs_route_outcome_after_end');
  });

  it('【失败】给了 endedAt 但 outcome 是空：库拒收（runs_outcome_iff_ended）', async () => {
    await expectViolation(insertRun({ endedAt: NOW }), 'runs_outcome_iff_ended');
  });

  it('【失败】给了 outcome 但 endedAt 是空：库拒收（runs_outcome_iff_ended）', async () => {
    await expectViolation(insertRun({ outcome: 'done' }), 'runs_outcome_iff_ended');
  });

  it('【失败】endedAt 早于 startedAt：库拒收（runs_ended_after_start）', async () => {
    await expectViolation(
      insertRun({ startedAt: NOW, endedAt: ago(MIN), outcome: 'done' }),
      'runs_ended_after_start',
    );
  });

  it('【失败】issueNumber = 0 / 负数：库拒收（runs_issue_positive）', async () => {
    await expectViolation(
      insertRun({ issueNumber: 0, endedAt: NOW, outcome: 'done' }),
      'runs_issue_positive',
    );
    await expectViolation(
      insertRun({ issueNumber: -3, endedAt: NOW, outcome: 'done' }),
      'runs_issue_positive',
    );
  });

  it('【失败】prNumber = 0：库拒收（runs_pr_positive）', async () => {
    await expectViolation(insertRun({ prNumber: 0, endedAt: NOW, outcome: 'done' }), 'runs_pr_positive');
  });

  it('【失败】token / costUsd 给负数：库拒收（runs_usage_nonneg）', async () => {
    for (const over of [
      { inputTokens: -1 },
      { outputTokens: -1 },
      { cacheReadTokens: -1 },
      { cacheWriteTokens: -1 },
      { costUsd: -0.000001 },
    ] as const) {
      await expectViolation(insertRun({ ...over, endedAt: NOW, outcome: 'done' }), 'runs_usage_nonneg');
    }
  });

  it('【失败】retryOf 指到不存在的 runs.id：外键拒收（runs_retry_of_self_fk）', async () => {
    await expectViolation(
      insertRun({ retryOf: randomUUID(), endedAt: NOW, outcome: 'done' }),
      'runs_retry_of_self_fk',
    );
  });

  it('retryOf 指到真的跑过的那一笔：放行（链条成立）', async () => {
    const first = randomUUID();
    const second = randomUUID();
    await insertRun({ id: first, endedAt: NOW, outcome: 'done' });
    await insertRun({ id: second, retryOf: first, endedAt: NOW, outcome: 'done' });
    const [row] = await t.db.select().from(runs).where(eq(runs.id, second));
    expect(row?.retryOf).toBe(first);
  });

  it('taskId 外键：指到不存在的 tasks 拒收（runs_task_id_tasks_id_fk）', async () => {
    await expectViolation(
      insertRun({ taskId: randomUUID(), endedAt: NOW, outcome: 'done' }),
      'runs_task_id_tasks_id_fk',
    );
  });

  it('taskId 是空：放行（不属于任何需求的会话）', async () => {
    const id = randomUUID();
    await insertRun({ id, taskId: null, endedAt: NOW, outcome: 'done' });
    const [row] = await t.db.select().from(runs).where(eq(runs.id, id));
    expect(row?.taskId).toBeNull();
  });

  it('【失败】routeId 指到不存在的路由：外键拒收（runs_route_id_routes_id_fk），免得切号连不到池、漏数在跑的会话', async () => {
    await expectViolation(insertRun({ routeId: 'nope-r' }), 'runs_route_id_routes_id_fk');
    const id = randomUUID();
    await insertRun({ id, routeId: 'kimi-r' });
    const [row] = await t.db.select().from(runs).where(eq(runs.id, id));
    expect(row).toMatchObject({ routeId: 'kimi-r', endedAt: null, outcome: null });
  });
});

describe('startRun / closeOpenRuns：开跑留一行没结束的，引擎起来时收掉上一轮留下的（#157）', () => {
  it('开跑那一行带路由、没结束；收场同一个编号整行补完，不多出一行', async () => {
    const id = randomUUID();
    await startRun(
      t.db,
      {
        id,
        segment: 'manual',
        model: 'kimi-k3',
        routeId: 'kimi-r',
        issueNumber: 157,
        startedAt: ago(5 * MIN),
      },
      ago(5 * MIN),
    );
    expect(await getRun(t.db, id)).toMatchObject({ routeId: 'kimi-r', endedAt: null, outcome: null });
    expect((await listOpenRuns(t.db)).map((r) => r.id)).toEqual([id]);
    await startRun(t.db, {
      id,
      segment: 'manual',
      model: 'kimi-k3',
      routeId: 'kimi-r',
      issueNumber: 157,
      startedAt: ago(5 * MIN),
      endedAt: NOW,
      outcome: 'done',
      inputTokens: 10,
    });
    const all = await t.db.select().from(runs).where(eq(runs.id, id));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ routeId: 'kimi-r', endedAt: NOW, outcome: 'done', inputTokens: 10 });
    expect(await listOpenRuns(t.db)).toEqual([]);
  });

  it('已经收场的那一行再收到一次开跑（重放、重试）：endedAt、outcome 和用量原样留着，不被冲回「还在跑」；开跑写的列照旧整行覆盖', async () => {
    const id = randomUUID();
    const base = {
      id,
      segment: 'manual',
      model: 'kimi-k3',
      routeId: 'kimi-r',
      startedAt: ago(5 * MIN),
    } as const;
    await startRun(t.db, { ...base, issueNumber: 157 }, ago(5 * MIN));
    await startRun(t.db, {
      ...base,
      issueNumber: 157,
      endedAt: NOW,
      outcome: 'failed',
      routeOutcome: 'ok',
      inputTokens: 10,
      costUsd: 0.5,
      failureReason: '退出码 1',
    });
    // 开跑那一笔又来一次：没带结局、也没带这一次的单号
    await startRun(t.db, { ...base, tier: 'fast' });
    expect(await getRun(t.db, id)).toMatchObject({
      endedAt: NOW,
      outcome: 'failed',
      routeOutcome: 'ok',
      inputTokens: 10,
      costUsd: 0.5,
      failureReason: '退出码 1',
      tier: 'fast',
      issueNumber: null,
    });
    expect(await listOpenRuns(t.db)).toEqual([]);
    // 给了结局的收场照样覆盖已有的（引擎重启收成 killed 之后，迟到的真结局以它为准）
    await startRun(t.db, {
      ...base,
      endedAt: new Date(NOW.getTime() + MIN),
      outcome: 'done',
      routeOutcome: 'ok',
    });
    expect(await getRun(t.db, id)).toMatchObject({
      endedAt: new Date(NOW.getTime() + MIN),
      outcome: 'done',
      inputTokens: 10,
    });
  });

  it('【失败】收场只给 endedAt 不给 outcome：库的一对空/不空约束仍然拒收，不靠保留旧值蒙混', async () => {
    const id = randomUUID();
    await startRun(t.db, { id, segment: 'manual', model: 'kimi-k3', startedAt: ago(MIN) });
    await expect(
      startRun(t.db, { id, segment: 'manual', model: 'kimi-k3', startedAt: ago(MIN), endedAt: NOW }),
    ).rejects.toThrow('写入 runs 失败');
    expect((await getRun(t.db, id))?.endedAt).toBeNull();
  });

  it('还开着的收成 killed、写明为什么、交回编号、不算路由的账；收过场的不动；收的时刻早于开跑时刻按开跑时刻收', async () => {
    const open = randomUUID();
    const future = randomUUID();
    const done = randomUUID();
    await startRun(t.db, {
      id: open,
      segment: 'manual',
      model: 'kimi-k3',
      routeId: 'kimi-r',
      startedAt: ago(30 * MIN),
    });
    // 时钟回拨：开跑时刻比收的时刻还晚
    await startRun(t.db, {
      id: future,
      segment: 'verify',
      model: 'kimi-k3',
      startedAt: new Date(NOW.getTime() + MIN),
    });
    await startRun(t.db, {
      id: done,
      segment: 'manual',
      model: 'kimi-k3',
      startedAt: ago(40 * MIN),
      endedAt: ago(35 * MIN),
      outcome: 'done',
      routeOutcome: 'ok',
    });
    const closed = await closeOpenRuns(t.db, { endedAt: NOW, reason: '引擎重启时这一段还没收场' });
    expect(closed.sort()).toEqual([open, future].sort());
    expect(await getRun(t.db, open)).toMatchObject({
      endedAt: NOW,
      outcome: 'killed',
      routeOutcome: 'neutral',
      failureReason: '引擎重启时这一段还没收场',
    });
    expect((await getRun(t.db, future))?.endedAt).toEqual(new Date(NOW.getTime() + MIN));
    expect(await getRun(t.db, done)).toMatchObject({
      endedAt: ago(35 * MIN),
      outcome: 'done',
      routeOutcome: 'ok',
      failureReason: null,
    });
    expect(await closeOpenRuns(t.db, { endedAt: NOW, reason: '再收一遍' })).toEqual([]);
  });

  it('【失败】不写为什么：拒收，一行都不动', async () => {
    const open = randomUUID();
    await startRun(t.db, { id: open, segment: 'manual', model: 'kimi-k3', startedAt: ago(MIN) });
    await expect(closeOpenRuns(t.db, { endedAt: NOW, reason: '  ' })).rejects.toThrow('要写为什么');
    expect((await getRun(t.db, open))?.endedAt).toBeNull();
  });
});

describe('saveVerifyRound：同一次写入两头都落', () => {
  it("verify_rounds 里记细节、runs 里记流水（segment='verify'，同根 id；读不到的字段为 NULL，不拿 0 顶）", async () => {
    const { task, row } = await fixture();
    await saveVerifyRound(t.db, row, NOW);

    const [round] = await t.db.select().from(verifyRounds).where(eq(verifyRounds.id, row.id));
    expect(round).toMatchObject({ taskId: task.id, verdict: 'pass', finalVerdict: 'pass' });

    const [runRow] = await t.db.select().from(runs).where(eq(runs.id, row.id));
    expect(runRow).toMatchObject({
      id: row.id,
      segment: 'verify',
      taskId: task.id,
      model: 'kimi-k3',
      routeId: 'kimi-r',
      startedAt: NOW,
      endedAt: NOW,
      outcome: 'done',
      issueNumber: null,
      channel: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      memoryPeakMb: null,
      failureReason: null,
      prNumber: null,
      branch: null,
      workflowId: null,
      temporalRunId: null,
      retryOf: null,
      createdAt: NOW,
    });
  });

  it('第二次写同一个 id（Lead 驳回之后）：verify_rounds 整行被改、runs 流水整行覆盖（不重复一份）', async () => {
    const { row } = await fixture();
    await saveVerifyRound(
      t.db,
      { ...row, verdict: 'block', finalVerdict: 'block', reasons: ['安全：密钥写进日志'] },
      ago(5 * MIN),
    );
    await saveVerifyRound(
      t.db,
      {
        ...row,
        verdict: 'block',
        finalVerdict: 'pass',
        rebuttals: [{ target: '密钥写进日志', evidence: 'log.ts 第 8 行打的是密钥编号不是值' }],
        reasons: [],
      },
      NOW,
    );
    const allRuns = await t.db.select().from(runs).where(eq(runs.id, row.id));
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({ startedAt: NOW, updatedAt: NOW });
  });

  it('作废（invalid）：verify_rounds 里 invalid_why 写清原因，runs 流水 failure_reason 同步带上', async () => {
    const { row } = await fixture();
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
    const [runRow] = await t.db.select().from(runs).where(eq(runs.id, row.id));
    expect(runRow).toMatchObject({ outcome: 'done', failureReason: '审的不是送检的头' });
  });

  it('老行照读：绕过 saveVerifyRound 直接在 verify_rounds 写一行（本切片上线前的老行），verifyRoundsOfTask 返回里有它', async () => {
    const { task, run } = await fixture();
    const legacyId = randomUUID();
    // 直接插 verify_rounds（不走 saveVerifyRound），模拟本切片上线前的老行：runs 里没有对应流水。
    await t.db.insert(verifyRounds).values({
      id: legacyId,
      taskId: task.id,
      round: 1,
      head: 'b'.repeat(40),
      runId: run.id,
      routeId: 'kimi-r',
      family: 'kimi',
      authorFamilies: ['claude'],
      criteria: ['老行的验收条'],
      report: { head: 'b'.repeat(40), results: [], findings: [] },
      verdict: 'pass',
      invalidWhy: null,
      rebuttals: [],
      finalVerdict: 'pass',
      reasons: [],
      notes: [],
      createdAt: ago(60 * MIN),
      updatedAt: ago(60 * MIN),
    });
    const runsForLegacy = await t.db.select().from(runs).where(eq(runs.id, legacyId));
    expect(runsForLegacy).toHaveLength(0);

    const rows = await verifyRoundsOfTask(t.db, task.id);
    expect(rows.map((r) => r.id)).toContain(legacyId);
    expect(rows.find((r) => r.id === legacyId)).toMatchObject({ verdict: 'pass', finalVerdict: 'pass' });
  });

  it('多次写入的好几轮 verifyRoundOfTask 都返回，按写入先后排（createdAt、round）', async () => {
    const { task, row } = await fixture();
    await saveVerifyRound(t.db, row, ago(10 * MIN));
    await saveVerifyRound(t.db, { ...row, id: randomUUID(), round: 2 }, NOW);
    const rows = await verifyRoundsOfTask(t.db, task.id);
    expect(rows.map((r) => r.round)).toEqual([1, 2]);
  });

  it('【失败】saveVerifyRound 用的路由在 routes 里没有：明确报错（「不拿空顶」），不是塞空字符串进 runs', async () => {
    const { row } = await fixture();
    await expect(saveVerifyRound(t.db, { ...row, routeId: 'nope-r' }, NOW)).rejects.toThrow(/routes 里没有/);
  });
});

describe('runs 表读端：按段查、按 task 查', () => {
  it("runs 里能按 segment='verify' 查这一张单的账", async () => {
    const { task, row } = await fixture();
    await saveVerifyRound(t.db, row, NOW);
    const all = await t.db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, task.id), eq(runs.segment, 'verify')));
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(row.id);
  });

  it('startRun 带上派工档就记下；不给就是 NULL（没记，不猜）', async () => {
    const { id } = await startRun(
      t.db,
      { segment: 'manual', model: 'kimi-k3', tier: 'fast', startedAt: ago(5 * MIN) },
      NOW,
    );
    const { id: blank } = await startRun(t.db, { segment: 'manual', model: 'kimi-k3' }, NOW);
    const rows = await t.db.select({ id: runs.id, tier: runs.tier }).from(runs);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.tier]))).toEqual({ [id]: 'fast', [blank]: null });
  });
});

describe('runsOfTask：一张单的三段流水（任务详情读）', () => {
  const WF = 'task:acme/web#77';

  async function setup() {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { issueNumber: 77 });
    const other = await addTask(t.db, (await addRepo(t.db)).id, { issueNumber: 77 });
    const run = (over: Parameters<typeof startRun>[1]) => startRun(t.db, over, NOW).then((r) => r.id);
    return { task, other, run };
  }

  it('按 task_id 对上的、task_id 没记但单号对上的（兜底）都收，按起跑先后排', async () => {
    const { task, run } = await setup();
    const verify = await run({ segment: 'verify', model: 'gpt-5.6', taskId: task.id, startedAt: ago(MIN) });
    const manual = await run({
      segment: 'manual',
      model: 'opus-5.5',
      issueNumber: 77,
      startedAt: ago(9 * MIN),
    });
    const scope = await run({
      segment: 'scope',
      model: 'opus-5.5',
      taskId: task.id,
      startedAt: ago(20 * MIN),
    });
    const rows = await runsOfTask(t.db, { id: task.id, issueNumber: 77, workflowId: WF });
    expect(rows.map((r) => r.id)).toEqual([scope, manual, verify]);
    expect(rows.find((r) => r.id === manual)?.taskId).toBeNull();
  });

  it('兜底只认没记 task_id 的：记了别的单的 task_id，哪怕单号一样也不收', async () => {
    const { task, other, run } = await setup();
    await run({ segment: 'manual', model: 'opus-5.5', taskId: other.id, issueNumber: 77 });
    expect(await runsOfTask(t.db, { id: task.id, issueNumber: 77, workflowId: WF })).toEqual([]);
  });

  it('兜底的行记了工作流编号、却不是这张单的（别的仓同号）：不收；记的就是这张单的照收', async () => {
    const { task, run } = await setup();
    await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77, workflowId: 'task:acme/other#77' });
    const mine = await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77, workflowId: WF });
    const rows = await runsOfTask(t.db, { id: task.id, issueNumber: 77, workflowId: WF });
    expect(rows.map((r) => r.id)).toEqual([mine]);
  });

  it('单号对不上、也没 task_id 的不收（巡检、实验这类不属于这张单）', async () => {
    const { task, run } = await setup();
    await run({ segment: 'verify', model: 'gpt-5.6', issueNumber: 78 });
    await run({ segment: 'verify', model: 'gpt-5.6' });
    expect(await runsOfTask(t.db, { id: task.id, issueNumber: 77, workflowId: WF })).toEqual([]);
  });
});
