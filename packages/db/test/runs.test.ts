// runs 表（#555-3，#599）：三段每次跑一次的流水账。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  USAGE_NOTE_MASTER_OFF,
  USAGE_NOTE_MEMORY,
  USAGE_NOTE_NOT_STARTED,
  USAGE_NOTE_SPAWN_FAILED,
  USAGE_SESSION_UNREAD,
} from '@fleet-dao/shared';
import { eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listRunningEngineTasks } from '../src/queries/idle-running.ts';
import {
  annotateSessionlessRuns,
  closeOpenRuns,
  getRun,
  latestRunOfTask,
  observeRunSessionId,
  type RunInsert,
  runSessionIdStats,
  runsOfTask,
  startRun,
  taskTokenSpend,
} from '../src/queries/runs.ts';
import { runs } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addTask, ago, catalog, expectViolation, HOUR, MIN, NOW } from './helpers.ts';

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

/** 还没收场的行（ended_at 为空）。 */
const openRuns = () => t.db.select().from(runs).where(isNull(runs.endedAt));

describe('runs 表本身的约束', () => {
  async function insertRun(over: Partial<typeof runs.$inferInsert>) {
    await t.db.insert(runs).values({
      segment: 'verify',
      model: 'opus-5.5',
      startedAt: ago(10 * MIN),
      ...over,
    });
  }

  it('流里先拿到会话号时提前写回；收场后不接受迟到的号', async () => {
    const id = randomUUID();
    await startRun(t.db, {
      id,
      segment: 'manual',
      model: 'opus-4.9',
      routeId: 'kimi-r',
      startedAt: ago(MIN),
    });
    expect(await observeRunSessionId(t.db, { runId: id, sessionId: 'claude:real-1' })).toBe(true);
    expect((await getRun(t.db, id))?.sessionId).toBe('claude:real-1');
    await t.db.update(runs).set({ endedAt: NOW, outcome: 'done', routeOutcome: 'ok' }).where(eq(runs.id, id));
    expect(await observeRunSessionId(t.db, { runId: id, sessionId: 'claude:late' })).toBe(false);
    expect((await getRun(t.db, id))?.sessionId).toBe('claude:real-1');
  });

  it('开跑时保留续会话判定：续上的写期望会话号，改开新的写原因', async () => {
    const resumed = randomUUID();
    const fresh = randomUUID();
    await startRun(t.db, {
      id: resumed,
      segment: 'manual',
      model: 'opus-4.9',
      startedAt: ago(MIN),
      resumeSessionId: 'cursor:previous',
    });
    await startRun(t.db, {
      id: fresh,
      segment: 'manual',
      model: 'opus-4.9',
      startedAt: ago(MIN),
      resumeReason: '上一段没记下会话号',
    });
    expect(await getRun(t.db, resumed)).toMatchObject({
      resumeSessionId: 'cursor:previous',
      resumeReason: null,
    });
    expect(await getRun(t.db, fresh)).toMatchObject({
      resumeSessionId: null,
      resumeReason: '上一段没记下会话号',
    });
  });

  it('会话号缺失按执行方式分开计数，没路由的归 unknown', async () => {
    await addRoute(t.db, { id: 'cursor-r', poolId: 'relay-b', modelId: 'opus-4.9', hostId: 'cursor-agent' });
    await addRoute(t.db, { id: 'grok-r', poolId: 'relay-b', modelId: 'opus-4.9', hostId: 'grok' });
    await addRoute(t.db, { id: 'claude-r', poolId: 'relay-b', modelId: 'opus-4.9', hostId: 'claude-code' });
    const rows = [
      { id: randomUUID(), routeId: 'cursor-r', sessionId: null },
      { id: randomUUID(), routeId: 'cursor-r', sessionId: 'cursor:1' },
      { id: randomUUID(), routeId: 'grok-r', sessionId: null },
      { id: randomUUID(), routeId: 'claude-r', sessionId: null },
      { id: randomUUID(), routeId: 'kimi-r', sessionId: 'mirasim:1' },
      { id: randomUUID(), routeId: undefined, sessionId: null },
    ];
    for (const row of rows) {
      await insertRun({ ...row, endedAt: NOW, outcome: 'done' });
    }
    expect(await runSessionIdStats(t.db, { endedAfter: ago(HOUR) })).toEqual([
      { hostId: 'claude-code', endedRuns: 1, missingSessionIds: 1 },
      { hostId: 'cursor-agent', endedRuns: 2, missingSessionIds: 1 },
      { hostId: 'grok', endedRuns: 1, missingSessionIds: 1 },
      { hostId: 'mirasim', endedRuns: 1, missingSessionIds: 0 },
      { hostId: 'unknown', endedRuns: 1, missingSessionIds: 1 },
    ]);
  });

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
      cpuSeconds: null,
      prNumber: null,
      branch: null,
      workflowId: null,
      temporalRunId: null,
      retryOf: null,
    });
    expect(row?.endedAt).toEqual(NOW);
    expect(row?.outcome).toBe('done');
  });

  it('CPU 秒数：正整数记上；没给是 NULL；0 和负数拒收，不写 0（#1980）', async () => {
    const id = randomUUID();
    await insertRun({ id, segment: 'manual', cpuSeconds: 720, endedAt: NOW, outcome: 'done' });
    expect((await t.db.select().from(runs).where(eq(runs.id, id)))[0]?.cpuSeconds).toBe(720);
    await expectViolation(
      insertRun({ segment: 'manual', cpuSeconds: 0, endedAt: NOW, outcome: 'done' }),
      'runs_cpu_seconds_positive',
    );
    await expectViolation(
      insertRun({ segment: 'manual', cpuSeconds: -1, endedAt: NOW, outcome: 'done' }),
      'runs_cpu_seconds_positive',
    );
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
    expect((await openRuns()).map((r) => r.id)).toEqual([id]);
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
    expect(await openRuns()).toEqual([]);
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
    expect(await openRuns()).toEqual([]);
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
      sessionId: null,
      usageNote: '会话号没拿到，用量读不到',
      inputTokens: null,
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

describe('runs 表读端', () => {
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

describe('latestRunOfTask：续会话找上一段的会话号（决定 0088）', () => {
  async function setup() {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { issueNumber: 77 });
    const other = await addTask(t.db, repo.id, { issueNumber: 78 });
    const run = (over: Parameters<typeof startRun>[1]) => startRun(t.db, over, NOW).then((r) => r.id);
    return { task, other, run };
  }

  it('只认这张单的这一段：不记 task_id 的、别的段的、别的单的都不算', async () => {
    const { task, other, run } = await setup();
    await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77, startedAt: ago(30 * MIN) });
    const verify = await run({
      segment: 'verify',
      model: 'gpt-5.6',
      taskId: task.id,
      startedAt: ago(20 * MIN),
    });
    const otherTask = await run({
      segment: 'manual',
      model: 'opus-5.5',
      taskId: other.id,
      startedAt: ago(5 * MIN),
    });
    const mine = await run({ segment: 'manual', model: 'opus-5.5', taskId: task.id, startedAt: ago(MIN) });
    const row = await latestRunOfTask(t.db, { taskId: task.id, segment: 'manual' });
    expect(row?.id).toBe(mine);
    expect(verify).not.toBe(mine);
    expect(otherTask).not.toBe(mine);
    expect(
      await latestRunOfTask(t.db, { taskId: 'ffffffff-0000-4000-8000-000000000000', segment: 'manual' }),
    ).toBe(null);
  });

  it('给了起跑时刻就只看那之后起的：被暂停取消的那一段凭它找', async () => {
    const { task, run } = await setup();
    await run({ segment: 'manual', model: 'opus-5.5', taskId: task.id, startedAt: ago(10 * MIN) });
    const cut = new Date(NOW.getTime() - 5 * MIN);
    expect(await latestRunOfTask(t.db, { taskId: task.id, segment: 'manual', startedAfter: cut })).toBe(null);
    const after = await run({
      segment: 'manual',
      model: 'opus-5.5',
      taskId: task.id,
      startedAt: new Date(NOW.getTime() - MIN),
    });
    const row = await latestRunOfTask(t.db, { taskId: task.id, segment: 'manual', startedAfter: cut });
    expect(row?.id).toBe(after);
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

  it('按 task_id 对上的、task_id 没记但单号和工作流编号都对上的（兜底）都收，按起跑先后排', async () => {
    const { task, run } = await setup();
    const verify = await run({ segment: 'verify', model: 'gpt-5.6', taskId: task.id, startedAt: ago(MIN) });
    const manual = await run({
      segment: 'manual',
      model: 'opus-5.5',
      issueNumber: 77,
      workflowId: WF,
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

  it('重做的下一代（:r2）task_id 没记的也收；挂起键、别的仓、多出来的后缀不收', async () => {
    const { task, run } = await setup();
    const redo = await run({
      segment: 'verify',
      model: 'opus-5.5',
      issueNumber: 77,
      workflowId: `${WF}:r2`,
    });
    await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77, workflowId: `${WF}:park:x` });
    await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77, workflowId: `${WF}:r2:extra` });
    await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77, workflowId: `${WF}:r02` });
    await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77, workflowId: 'task:acme/other#77:r2' });
    const rows = await runsOfTask(t.db, { id: task.id, issueNumber: 77, workflowId: WF });
    expect(rows.map((r) => r.id)).toEqual([redo]);
  });

  it('兜底的行记了工作流编号、却不是这张单的（别的仓同号）：不收；记的就是这张单的照收', async () => {
    const { task, run } = await setup();
    await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77, workflowId: 'task:acme/other#77' });
    const mine = await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77, workflowId: WF });
    const rows = await runsOfTask(t.db, { id: task.id, issueNumber: 77, workflowId: WF });
    expect(rows.map((r) => r.id)).toEqual([mine]);
  });

  it('task_id 和工作流编号都没记、只有单号对得上的不收：分不出是哪个仓的，别的仓同号的会话混不进来', async () => {
    const { task, other, run } = await setup();
    const orphan = await run({ segment: 'manual', model: 'opus-5.5', issueNumber: 77 });
    expect(await runsOfTask(t.db, { id: task.id, issueNumber: 77, workflowId: WF })).toEqual([]);
    // 同一个单号、另一个仓：它的任务详情同样不收这一行
    expect(
      await runsOfTask(t.db, { id: other.id, issueNumber: 77, workflowId: 'task:acme/other#77' }),
    ).toEqual([]);
    expect((await t.db.select({ id: runs.id }).from(runs)).map((r) => r.id)).toEqual([orphan]);
  });

  it('单号对不上、也没 task_id 的不收（巡检、实验这类不属于这张单）', async () => {
    const { task, run } = await setup();
    await run({ segment: 'verify', model: 'gpt-5.6', issueNumber: 78 });
    await run({ segment: 'verify', model: 'gpt-5.6' });
    expect(await runsOfTask(t.db, { id: task.id, issueNumber: 77, workflowId: WF })).toEqual([]);
  });
});

describe('taskTokenSpend：单任务 token 预算（决定 0093）', () => {
  it('这张单动手和验收的四样 token 相加；别的单、别的段不算；用量全空的行不算钱、数出来、按量到的行估一个下限', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { issueNumber: 77 });
    const other = await addTask(t.db, repo.id, { issueNumber: 78 });
    const row = (over: Partial<typeof runs.$inferInsert>) =>
      t.db.insert(runs).values({ segment: 'manual', model: 'opus-5.5', startedAt: ago(10 * MIN), ...over });
    await row({
      taskId: task.id,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 1000,
      cacheWriteTokens: 5,
    });
    await row({ taskId: task.id, segment: 'verify', inputTokens: 1, outputTokens: 2 });
    await row({ taskId: task.id });
    await row({ taskId: task.id, segment: 'scope', inputTokens: 999_999 });
    await row({ taskId: other.id, inputTokens: 999_999 });
    // 量到的 1038 摊在两条量到的行上（600 + 600 = 1200 秒），空着的那一行也跑了 600 秒：估出来是 519
    expect(await taskTokenSpend(t.db, task.id)).toEqual({
      tokens: 1038,
      runs: 3,
      unmetered: 1,
      estimated: 519,
      // 原始四样分开给（#2830：折算在活动里做，库只交原始的）
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 1000,
      cacheWriteTokens: 5,
    });
    expect(await taskTokenSpend(t.db, randomUUID())).toEqual({
      tokens: 0,
      runs: 0,
      unmetered: 0,
      estimated: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('给了起算时间就只算这之后：上一代的 83.5M 不算，这一代自己超过 37M 仍算进去；不给起算时间仍是整张单', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { issueNumber: 2254 });
    const cutoff = new Date('2026-10-16T02:00:00Z');
    const row = (over: Partial<typeof runs.$inferInsert>) =>
      t.db.insert(runs).values({
        segment: 'manual',
        model: 'grok-4.7',
        taskId: task.id,
        startedAt: ago(10 * MIN),
        ...over,
      });
    await row({
      startedAt: new Date('2026-10-16T00:30:00Z'),
      inputTokens: 83_500_000,
    });
    expect(await taskTokenSpend(t.db, task.id, { since: cutoff })).toEqual({
      tokens: 0,
      runs: 0,
      unmetered: 0,
      estimated: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect((await taskTokenSpend(t.db, task.id)).tokens).toBe(83_500_000);
    await row({
      startedAt: new Date('2026-10-16T03:00:00Z'),
      inputTokens: 38_000_000,
    });
    expect(await taskTokenSpend(t.db, task.id, { since: cutoff })).toEqual({
      tokens: 38_000_000,
      runs: 1,
      unmetered: 0,
      estimated: 0,
      inputTokens: 38_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('一行用量都没记到（全被叫停）：没有速率可估，估出来是 0，只数出有几行没读到', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { issueNumber: 79 });
    await t.db
      .insert(runs)
      .values({ segment: 'manual', model: 'grok-4.7', taskId: task.id, startedAt: ago(10 * MIN) });
    expect(await taskTokenSpend(t.db, task.id)).toEqual({
      tokens: 0,
      runs: 1,
      unmetered: 1,
      estimated: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe('listRunningEngineTasks：在干活的引擎任务，带开着的会话数', () => {
  it('只列 running 且 executor=engine；开着的 runs 按 ended_at 为空来数，收过场的不算', async () => {
    const repo = await addRepo(t.db, 'fleet-dao');
    const idle = await addTask(t.db, repo.id, {
      issueNumber: 2261,
      state: 'running',
      executor: 'engine',
      updatedAt: ago(HOUR),
      doing: '换一条路由带上进度续一次',
    });
    const busy = await addTask(t.db, repo.id, {
      issueNumber: 2262,
      state: 'running',
      updatedAt: ago(MIN),
    });
    await addTask(t.db, repo.id, { issueNumber: 2263, state: 'running', executor: 'local' });
    await addTask(t.db, repo.id, { issueNumber: 2264, state: 'stalled', executor: 'engine' });
    const closed = await addTask(t.db, repo.id, { issueNumber: 2265, state: 'running' });
    await t.db.insert(runs).values({
      segment: 'manual',
      model: 'deepseek-flash',
      taskId: idle.id,
      startedAt: ago(2 * HOUR),
      endedAt: ago(HOUR),
      outcome: 'done',
    });
    await t.db.insert(runs).values({
      segment: 'manual',
      model: 'deepseek-flash',
      taskId: busy.id,
      startedAt: ago(MIN),
    });
    await t.db.insert(runs).values({
      segment: 'manual',
      model: 'deepseek-flash',
      taskId: closed.id,
      startedAt: ago(2 * HOUR),
      endedAt: ago(HOUR),
      outcome: 'done',
    });

    const rows = await listRunningEngineTasks(t.db);
    expect(rows.map((r) => [r.issueNumber, r.openRuns, r.owner, r.name])).toEqual([
      [2261, 0, 'acme', 'fleet-dao'],
      [2262, 1, 'acme', 'fleet-dao'],
      [2265, 0, 'acme', 'fleet-dao'],
    ]);
    expect(rows[0]?.doing).toContain('带上进度续一次');
    expect(rows[0]?.updatedAt).toEqual(ago(HOUR));
  });
});

describe('没有会话号的用量（#2689）', () => {
  const recent = () => new Date(Date.now() - 60_000);
  const at = new Date('2026-10-16T06:00:00Z');

  async function ended(over: Partial<RunInsert> & Pick<RunInsert, 'outcome'>) {
    const startedAt = new Date(recent().getTime() - 60_000);
    return startRun(t.db, { segment: 'manual', model: 'kimi-k3', startedAt, endedAt: recent(), ...over });
  }

  it('确定没调用的三种记 0 并写原因；读不准的只写原因、数留空；有会话号、已有原因、窗口外的不动', async () => {
    const memory = await ended({ outcome: 'admission_blocked', failureReason: '内存余量放不下' });
    const spawn = await ended({ outcome: 'spawn_failed', failureReason: '起子进程没起成：spawn ENOENT' });
    const master = await ended({
      outcome: 'org_switch',
      failureReason: '引擎总开关：总开关关着；这一段没起会话（还没起会话）',
    });
    const drained = await ended({
      outcome: 'org_switch',
      failureReason: '发布排空：到点了；这一段没起会话（还没起会话）',
    });
    const unread = await ended({ outcome: 'killed', failureReason: '引擎重启时这一段还没收场' });
    const partial = await ended({ outcome: 'done', outputTokens: 12 });
    const hasSession = await ended({ outcome: 'done', sessionId: 'claude:abc' });
    const noted = await ended({ outcome: 'killed', usageNote: '原先的原因' });
    const old = await startRun(t.db, {
      segment: 'manual',
      model: 'kimi-k3',
      startedAt: ago(HOUR),
      endedAt: NOW,
      outcome: 'admission_blocked',
    });

    const n = await annotateSessionlessRuns(t.db, {
      endedAfter: new Date(Date.now() - 14 * 24 * 60 * 60_000),
      at,
    });
    expect(n).toBe(6);

    expect(await getRun(t.db, memory.id)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      usageNote: USAGE_NOTE_MEMORY,
    });
    expect(await getRun(t.db, spawn.id)).toMatchObject({
      inputTokens: 0,
      costUsd: 0,
      usageNote: USAGE_NOTE_SPAWN_FAILED,
    });
    expect(await getRun(t.db, master.id)).toMatchObject({
      inputTokens: 0,
      costUsd: 0,
      usageNote: USAGE_NOTE_MASTER_OFF,
    });
    expect(await getRun(t.db, drained.id)).toMatchObject({
      inputTokens: 0,
      costUsd: 0,
      usageNote: USAGE_NOTE_NOT_STARTED,
    });
    expect(await getRun(t.db, unread.id)).toMatchObject({
      inputTokens: null,
      costUsd: null,
      usageNote: USAGE_SESSION_UNREAD,
    });
    expect(await getRun(t.db, partial.id)).toMatchObject({
      outputTokens: 12,
      inputTokens: null,
      usageNote: USAGE_SESSION_UNREAD,
    });
    expect(await getRun(t.db, hasSession.id)).toMatchObject({
      sessionId: 'claude:abc',
      usageNote: null,
      inputTokens: null,
    });
    expect(await getRun(t.db, noted.id)).toMatchObject({ usageNote: '原先的原因', inputTokens: null });
    expect(await getRun(t.db, old.id)).toMatchObject({ usageNote: null, inputTokens: null });

    expect(await annotateSessionlessRuns(t.db, { endedAfter: new Date(0), at })).toBe(1);
    expect(await getRun(t.db, old.id)).toMatchObject({ inputTokens: 0, usageNote: USAGE_NOTE_MEMORY });
  });

  it('有会话号的开着的行被收掉时不写「读不到」', async () => {
    const id = randomUUID();
    await startRun(t.db, {
      id,
      segment: 'manual',
      model: 'kimi-k3',
      startedAt: ago(MIN),
      sessionId: 'claude:still-running',
    });
    await closeOpenRuns(t.db, { endedAt: NOW, reason: '引擎重启时这一段还没收场' });
    expect(await getRun(t.db, id)).toMatchObject({
      outcome: 'killed',
      sessionId: 'claude:still-running',
      usageNote: null,
      inputTokens: null,
    });
  });

  it('迁移语句和补写函数同一套说法：近 14 天没会话号的补上，更早的不动', async () => {
    const memory = await ended({ outcome: 'admission_blocked', failureReason: '内存余量放不下' });
    const unread = await ended({ outcome: 'timeout', failureReason: '超过时限' });
    const old = await startRun(t.db, {
      segment: 'verify',
      model: 'kimi-k3',
      startedAt: ago(2 * HOUR),
      endedAt: NOW,
      outcome: 'spawn_failed',
    });
    const text = readFileSync(
      join(import.meta.dirname, '../migrations/0079_sessionless_usage_notes.sql'),
      'utf8',
    );
    for (const phrase of [
      USAGE_NOTE_MASTER_OFF,
      USAGE_NOTE_MEMORY,
      USAGE_NOTE_SPAWN_FAILED,
      USAGE_NOTE_NOT_STARTED,
      USAGE_SESSION_UNREAD,
    ]) {
      expect(text).toContain(phrase);
    }
    for (const statement of text
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.includes('UPDATE'))) {
      await t.db.execute(sql.raw(statement));
    }
    expect(await getRun(t.db, memory.id)).toMatchObject({
      inputTokens: 0,
      costUsd: 0,
      usageNote: USAGE_NOTE_MEMORY,
    });
    expect(await getRun(t.db, unread.id)).toMatchObject({
      inputTokens: null,
      usageNote: USAGE_SESSION_UNREAD,
    });
    expect(await getRun(t.db, old.id)).toMatchObject({ inputTokens: null, usageNote: null });
  });
});
