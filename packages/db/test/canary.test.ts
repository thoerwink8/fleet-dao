// 全流程巡检（#223）的记录和它每一回从库里读的事实：没跑成、断了、通过分开记，读不到的不拿空顶。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canaryDbFacts,
  canaryRunById,
  concludeAbandonedCanaryRuns,
  finishCanaryRun,
  latestCanaryRuns,
  leftoverCanaryRuns,
  markCanaryCleaned,
  saveCanaryProgress,
  startCanaryRun,
} from '../src/queries/canary.ts';
import { upsertAlert } from '../src/queries/engine.ts';
import { registerScheduledJobs, startScheduleRun } from '../src/queries/schedule.ts';
import { githubEvents, githubEventVersions, repos, stepTimings } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addSubtask,
  addTask,
  ago,
  catalog,
  expectViolation,
  MIN,
  NOW,
} from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

const JOB = { id: 'canary', name: '全流程巡检', schedule: '每 6 小时', expectEveryMinutes: 780 };

async function round(repo: string | null = 'acme/canary', at = ago(60 * MIN)) {
  await registerScheduledJobs(t.db, [JOB]);
  const scheduleRunId = await startScheduleRun(t.db, 'canary', at);
  const id = await startCanaryRun(t.db, { scheduleRunId, repo, at });
  return { id, scheduleRunId };
}

describe('巡检一轮的记录', () => {
  it('开始时停在「开单」、没有结论；健康页读到的是「在跑」那一轮，还没有有结论的', async () => {
    const { id } = await round();
    const row = await canaryRunById(t.db, id);
    expect(row).toMatchObject({
      stage: 'open',
      verdict: null,
      endedAt: null,
      steps: [],
      repo: 'acme/canary',
    });
    const latest = await latestCanaryRuns(t.db);
    expect(latest.finished).toBeNull();
    expect(latest.running?.id).toBe(id);
  });

  it('走到哪写进度；有了结论就不再改（进度、结论都不改），重记结论回 already_finished，没有这一轮回 not_found', async () => {
    const { id } = await round();
    const repo = await addRepo(t.db, 'canary');
    const task = await addTask(t.db, repo.id, { issueNumber: 12 });
    const steps = [
      { stage: 'open' as const, at: ago(50 * MIN).toISOString() },
      { stage: 'intake' as const, at: ago(40 * MIN).toISOString() },
    ];
    expect(
      await saveCanaryProgress(t.db, id, {
        stage: 'dispatch',
        steps,
        issueNumber: 12,
        taskId: task.id,
        at: NOW,
      }),
    ).toBe(true);
    expect(await canaryRunById(t.db, id)).toMatchObject({
      stage: 'dispatch',
      issueNumber: 12,
      taskId: task.id,
      steps,
    });
    expect(
      await finishCanaryRun(t.db, id, { verdict: 'pass', stage: 'board', why: null, steps, at: NOW }),
    ).toBe('ok');
    expect(await saveCanaryProgress(t.db, id, { stage: 'plan', steps: [], at: NOW })).toBe(false);
    expect(
      await finishCanaryRun(t.db, id, {
        verdict: 'broken',
        stage: 'plan',
        why: '又断了',
        steps: [],
        at: NOW,
      }),
    ).toBe('already_finished');
    expect(await canaryRunById(t.db, id)).toMatchObject({ verdict: 'pass', stage: 'board', why: null });
    expect(
      await finishCanaryRun(t.db, 9999, { verdict: 'pass', stage: 'board', why: null, steps: [], at: NOW }),
    ).toBe('not_found');
    const latest = await latestCanaryRuns(t.db);
    expect(latest.finished?.id).toBe(id);
    expect(latest.running).toBeNull();
  });

  it('【故意造出的失败】断了、没跑成却不写为什么：库里的约束拒掉，不许「没通过，也不知道为什么」', async () => {
    const { id } = await round();
    await expectViolation(
      finishCanaryRun(t.db, id, { verdict: 'broken', stage: 'dispatch', why: null, steps: [], at: NOW }),
      'canary_runs_not_pass_has_why',
    );
    await expectViolation(
      finishCanaryRun(t.db, id, { verdict: 'not_run', stage: 'open', why: '', steps: [], at: NOW }),
      'canary_runs_not_pass_has_why',
    );
  });

  it('健康页读最近一轮有结论的：按结束时刻取，没跑成的也算最近一轮（不跳过它去拿上一次通过的）', async () => {
    const a = await round('acme/canary', ago(20 * 60 * MIN));
    await finishCanaryRun(t.db, a.id, {
      verdict: 'pass',
      stage: 'board',
      why: null,
      steps: [],
      at: ago(19 * 60 * MIN),
    });
    const b = await round('acme/canary', ago(8 * 60 * MIN));
    await finishCanaryRun(t.db, b.id, {
      verdict: 'not_run',
      stage: 'open',
      why: '读不到巡检仓还开着的里程碑',
      steps: [],
      at: ago(8 * 60 * MIN),
    });
    const latest = await latestCanaryRuns(t.db);
    expect(latest.finished).toMatchObject({
      id: b.id,
      verdict: 'not_run',
      why: '读不到巡检仓还开着的里程碑',
    });
  });

  it('前几轮留下的单：只列这个仓的、断了或没跑成的、开成了单的、还没收掉的；收掉以后不再列', async () => {
    const pass = await round();
    await finishCanaryRun(t.db, pass.id, {
      verdict: 'pass',
      stage: 'board',
      why: null,
      steps: [],
      issueNumber: 3,
      at: NOW,
    });
    const broken = await round();
    await finishCanaryRun(t.db, broken.id, {
      verdict: 'broken',
      stage: 'plan',
      why: '挂起',
      steps: [],
      issueNumber: 5,
      at: NOW,
    });
    const noIssue = await round();
    await finishCanaryRun(t.db, noIssue.id, {
      verdict: 'not_run',
      stage: 'open',
      why: '开不了单',
      steps: [],
      at: NOW,
    });
    const other = await round('acme/other');
    await finishCanaryRun(t.db, other.id, {
      verdict: 'broken',
      stage: 'plan',
      why: '挂起',
      steps: [],
      issueNumber: 7,
      at: NOW,
    });
    const running = await round();
    await saveCanaryProgress(t.db, running.id, { stage: 'plan', steps: [], issueNumber: 9, at: NOW });

    const left = await leftoverCanaryRuns(t.db, { repo: 'acme/canary', limit: 5 });
    expect(left.map((r) => r.issueNumber)).toEqual([5]);
    await markCanaryCleaned(t.db, broken.id, NOW);
    expect(await leftoverCanaryRuns(t.db, { repo: 'acme/canary', limit: 5 })).toEqual([]);
    await expect(markCanaryCleaned(t.db, 9999, NOW)).rejects.toThrow('没有这一轮巡检');
    await expect(leftoverCanaryRuns(t.db, { repo: 'acme/canary', limit: 0 })).rejects.toThrow('limit');
  });

  it('【故意造出的失败】没收尾的一轮（工作流没了、一直没结论）：补记成没跑成、写明原因，之后照留下的单收；在跑的、有结论的不动', async () => {
    const lost = await round('acme/canary', ago(7 * 60 * MIN));
    await saveCanaryProgress(t.db, lost.id, {
      stage: 'plan',
      steps: [],
      issueNumber: 5,
      at: ago(6 * 60 * MIN),
    });
    const done = await round('acme/canary', ago(8 * 60 * MIN));
    await finishCanaryRun(t.db, done.id, {
      verdict: 'pass',
      stage: 'board',
      why: null,
      steps: [],
      at: ago(7 * 60 * MIN),
    });
    const flying = await round('acme/canary', ago(30 * MIN));
    const why = '这一轮过了 5.5 小时还没有结论：巡检的工作流没收尾就没了';
    const got = await concludeAbandonedCanaryRuns(t.db, { before: ago(5.5 * 60 * MIN), why, at: NOW });
    expect(got).toEqual([{ id: lost.id, scheduleRunId: lost.scheduleRunId, issueNumber: 5 }]);
    expect(await canaryRunById(t.db, lost.id)).toMatchObject({
      verdict: 'not_run',
      stage: 'plan',
      why,
      endedAt: NOW,
    });
    expect(await canaryRunById(t.db, done.id)).toMatchObject({ verdict: 'pass', why: null });
    expect(await canaryRunById(t.db, flying.id)).toMatchObject({ verdict: null });
    // 补记过的不再补；它开成了的单照前几轮留下的单收
    expect(await concludeAbandonedCanaryRuns(t.db, { before: ago(5.5 * 60 * MIN), why, at: NOW })).toEqual(
      [],
    );
    expect((await leftoverCanaryRuns(t.db, { repo: 'acme/canary', limit: 5 })).map((r) => r.id)).toEqual([
      lost.id,
    ]);
    await expect(concludeAbandonedCanaryRuns(t.db, { before: NOW, why: ' ', at: NOW })).rejects.toThrow(
      '原因',
    );
  });
});

describe('巡检每一回从库里读的事实', () => {
  it('巡检仓不在库里：repo 是空的，别的都是空（不报错、也不冒充有任务）', async () => {
    const facts = await canaryDbFacts(t.db, { owner: 'acme', name: 'canary', issueNumber: 1 });
    expect(facts).toMatchObject({ repo: null, task: null, sessions: { total: 0 }, timings: 0, block: null });
  });

  it('收进来之前：仓在、没有任务行，带上最近一次投递怎么处理的（没派的原因看得见）', async () => {
    const repo = await addRepo(t.db, 'canary');
    await t.db.update(repos).set({ autoDispatchSince: ago(600 * MIN) });
    await t.db.insert(githubEvents).values([
      {
        deliveryId: 'd1',
        event: 'issues',
        action: 'opened',
        source: 'webhook',
        repo: 'acme/canary',
        payload: {},
        status: 'accepted',
        note: 'task=created, workflow=unscheduled',
        receivedAt: ago(10 * MIN),
        finishedAt: ago(10 * MIN),
      },
      {
        deliveryId: 'd2',
        event: 'issues',
        action: 'milestoned',
        source: 'webhook',
        repo: 'acme/canary',
        payload: {},
        status: 'failed',
        reason: '没查成：读不到挂在哪个版本',
        receivedAt: ago(5 * MIN),
        finishedAt: ago(5 * MIN),
      },
    ]);
    await t.db.insert(githubEventVersions).values([
      { deliveryId: 'd1', object: 'acme/canary:issue:12', version: ago(10 * MIN), state: 'open' },
      { deliveryId: 'd2', object: 'acme/canary:issue:12', version: ago(5 * MIN), state: 'open' },
    ]);
    const facts = await canaryDbFacts(t.db, { owner: 'acme', name: 'canary', issueNumber: 12 });
    expect(facts.repo).toMatchObject({ id: repo.id });
    expect(facts.repo?.autoDispatchSince?.getTime()).toBe(ago(600 * MIN).getTime());
    expect(facts.task).toBeNull();
    expect(facts.lastDelivery).toEqual({
      event: 'issues',
      action: 'milestoned',
      status: 'failed',
      reason: '没查成：读不到挂在哪个版本',
      note: null,
    });
  });

  it('收进来以后：任务行、会话几个起来了几个结束了几个有用量、每步耗时几笔、块和 PR、这张单工作流的开着的提醒（别的单的不算）', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-4.9' });
    const repo = await addRepo(t.db, 'canary');
    const task = await addTask(t.db, repo.id, { issueNumber: 1, state: 'running', phase: 'fusion:execute' });
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'r1',
      stage: 'plan',
      startedAt: ago(20 * MIN),
      endedAt: ago(15 * MIN),
      outcome: 'ok',
      inputTokens: 1200,
    });
    await addRun(t.db, { taskId: task.id, routeId: 'r1', startedAt: ago(10 * MIN) });
    await addRun(t.db, { taskId: task.id, routeId: 'r1' });
    await addSubtask(t.db, task.id, { key: 'fusion', state: 'verifying', prNumber: 4 });
    await t.db.insert(stepTimings).values({
      kind: 'activity',
      workflowId: 'req:acme/canary#1',
      temporalRunId: 'run-1',
      workflowType: 'fusionWorkflow',
      taskId: task.id,
      activity: 'createWorktree',
      attempt: 1,
      scheduledAt: ago(25 * MIN),
      startedAt: ago(25 * MIN),
      endedAt: ago(24 * MIN),
      queueMs: 0,
      runMs: 60_000,
      outcome: 'ok',
    });
    await upsertAlert(t.db, {
      dedupeKey: 'req:acme/canary#1:park:1',
      level: 'alert',
      taskId: task.id,
      title: '「plan」没有能用的路由',
      body: '一条都派不出去',
    });
    // 别的单（#12）的提醒：前缀只差一位，不能算进 #1
    await upsertAlert(t.db, {
      dedupeKey: 'req:acme/canary#12:park:1',
      level: 'alert',
      taskId: null,
      title: '别的单挂起了',
      body: '-',
    });
    const facts = await canaryDbFacts(t.db, { owner: 'acme', name: 'canary', issueNumber: 1 });
    expect(facts.task).toMatchObject({ id: task.id, state: 'running', phase: 'fusion:execute' });
    expect(facts.sessions).toEqual({ total: 3, started: 2, ended: 1, withUsage: 1 });
    expect(facts.timings).toBe(1);
    expect(facts.block).toEqual({ prNumber: 4, state: 'verifying' });
    expect(facts.openAlerts).toEqual([
      { dedupeKey: 'req:acme/canary#1:park:1', title: '「plan」没有能用的路由' },
    ]);
  });
});
