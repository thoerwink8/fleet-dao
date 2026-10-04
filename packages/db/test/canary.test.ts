// 全流程巡检（#223）的记录和它每一回从库里读的事实：没跑成、断了、通过分开记，读不到的不拿空顶。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canaryDbFacts,
  canaryPullRequestNumber,
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
import { startRun } from '../src/queries/runs.ts';
import { finishScheduleRun, registerScheduledJobs, startScheduleRun } from '../src/queries/schedule.ts';
import { CANARY_STAGE_NAMES, canaryRuns, pullRequests, repos, stepTimings } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, expectViolation, MIN, NOW } from './helpers.ts';

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
        stage: 'implement',
        steps,
        issueNumber: 12,
        taskId: task.id,
        at: NOW,
      }),
    ).toBe(true);
    expect(await canaryRunById(t.db, id)).toMatchObject({
      stage: 'implement',
      issueNumber: 12,
      taskId: task.id,
      steps,
    });
    expect(
      await finishCanaryRun(t.db, id, { verdict: 'pass', stage: 'board', why: null, steps, at: NOW }),
    ).toBe('ok');
    expect(await saveCanaryProgress(t.db, id, { stage: 'verify', steps: [], at: NOW })).toBe(false);
    expect(
      await finishCanaryRun(t.db, id, {
        verdict: 'broken',
        stage: 'verify',
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
      finishCanaryRun(t.db, id, { verdict: 'broken', stage: 'implement', why: null, steps: [], at: NOW }),
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
      stage: 'verify',
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
      stage: 'verify',
      why: '挂起',
      steps: [],
      issueNumber: 7,
      at: NOW,
    });
    const running = await round();
    await saveCanaryProgress(t.db, running.id, { stage: 'verify', steps: [], issueNumber: 9, at: NOW });

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
      stage: 'verify',
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
      stage: 'verify',
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
  /** 这一轮巡检开单的时刻：runs 的账只认这之后起的。 */
  const SINCE = ago(60 * MIN);
  const factsOf = (issueNumber: number) =>
    canaryDbFacts(t.db, { owner: 'acme', name: 'canary', issueNumber, since: SINCE, intakeJob: 'intake' });

  it('巡检仓不在库里：repo 是空的，别的都是空（不报错、也不冒充有任务）；拉单一轮都没跑过是 null', async () => {
    expect(await factsOf(1)).toEqual({
      repo: null,
      task: null,
      runs: { total: 0, ended: 0, manual: 0, verify: 0, withUsage: 0 },
      timings: 0,
      openAlerts: [],
      lastIntake: null,
    });
  });

  it('收进来之前：仓在、没有任务行，带上最近一轮拉单的结局（收单卡住时看得见拉单怎么了）', async () => {
    const repo = await addRepo(t.db, 'canary');
    await t.db.update(repos).set({ autoDispatchSince: ago(600 * MIN) });
    await registerScheduledJobs(t.db, [
      { id: 'intake', name: '引擎拉单', schedule: '每 5 分钟', expectEveryMinutes: 15 },
    ]);
    const older = await startScheduleRun(t.db, 'intake', ago(10 * MIN));
    await finishScheduleRun(t.db, older, { outcome: 'ok', scanned: 1, found: 0 }, ago(10 * MIN));
    const latest = await startScheduleRun(t.db, 'intake', ago(5 * MIN));
    await finishScheduleRun(t.db, latest, { outcome: 'failed', why: '白名单读不到' }, ago(5 * MIN));
    const facts = await factsOf(12);
    expect(facts.repo).toMatchObject({ id: repo.id });
    expect(facts.repo?.autoDispatchSince?.getTime()).toBe(ago(600 * MIN).getTime());
    expect(facts.task).toBeNull();
    expect(facts.lastIntake).toEqual({
      startedAt: ago(5 * MIN),
      endedAt: ago(5 * MIN),
      outcome: 'failed',
      why: '白名单读不到',
    });
  });

  it('收进来以后：任务行、runs 记的账（只认开单以后起的、这个单号的）、每步耗时、这张单任务工作流的开着的提醒（别的单的不算）', async () => {
    const repo = await addRepo(t.db, 'canary');
    const task = await addTask(t.db, repo.id, { issueNumber: 1, state: 'running', phase: 'verify' });
    // 动手两笔（一笔结束、记上了用量；一笔还在跑），验收一笔结束、用量读不到（留空，不当 0）
    await startRun(t.db, {
      segment: 'manual',
      issueNumber: 1,
      model: 'grok-5',
      startedAt: ago(40 * MIN),
      endedAt: ago(30 * MIN),
      outcome: 'done',
      inputTokens: 1200,
    });
    await startRun(t.db, { segment: 'manual', issueNumber: 1, model: 'grok-5', startedAt: ago(20 * MIN) });
    await startRun(t.db, {
      segment: 'verify',
      issueNumber: 1,
      model: 'opus-5.5',
      startedAt: ago(15 * MIN),
      endedAt: ago(10 * MIN),
      outcome: 'done',
    });
    // 开单以前就有的同号的账（别的仓、上一回的）、别的单号的账：都不算这张单的
    await startRun(t.db, {
      segment: 'manual',
      issueNumber: 1,
      model: 'grok-5',
      startedAt: ago(120 * MIN),
      endedAt: ago(110 * MIN),
      outcome: 'done',
      inputTokens: 9,
    });
    await startRun(t.db, {
      segment: 'verify',
      issueNumber: 12,
      model: 'opus-5.5',
      startedAt: ago(15 * MIN),
      endedAt: ago(10 * MIN),
      outcome: 'done',
      inputTokens: 9,
    });
    await t.db.insert(stepTimings).values({
      kind: 'activity',
      workflowId: 'task:acme/canary#1',
      temporalRunId: 'run-1',
      workflowType: 'taskWorkflow',
      taskId: task.id,
      activity: 'createWorktree',
      attempt: 1,
      scheduledAt: ago(45 * MIN),
      startedAt: ago(45 * MIN),
      endedAt: ago(44 * MIN),
      queueMs: 0,
      runMs: 60_000,
      outcome: 'ok',
    });
    await upsertAlert(t.db, {
      dedupeKey: 'task:acme/canary#1:park:1',
      level: 'alert',
      taskId: task.id,
      title: '没有可用的路由',
      body: '一条都派不出去',
    });
    // 别的单（#12）的提醒：前缀只差一位，不能算进 #1；Fusion 时代 req: 开头的也不算
    await upsertAlert(t.db, {
      dedupeKey: 'task:acme/canary#12:park:1',
      level: 'alert',
      taskId: null,
      title: '别的单停下了',
      body: '-',
    });
    await upsertAlert(t.db, {
      dedupeKey: 'req:acme/canary#1:park:1',
      level: 'alert',
      taskId: null,
      title: '老的需求工作流挂起了',
      body: '-',
    });
    const facts = await factsOf(1);
    expect(facts.task).toMatchObject({ id: task.id, state: 'running', phase: 'verify' });
    expect(facts.runs).toEqual({ total: 3, ended: 2, manual: 2, verify: 1, withUsage: 1 });
    expect(facts.timings).toBe(1);
    expect(facts.openAlerts).toEqual([{ dedupeKey: 'task:acme/canary#1:park:1', title: '没有可用的路由' }]);
  });
});

describe('canaryPullRequestNumber：任务做得快、工作流已经不在跑时，按单号从 PR 镜像找引擎给这张单开的 PR（#452）', () => {
  const sha = 'a'.repeat(40);
  const addPr = (repoId: string, number: number, headRef: string, issueRefs: number[]) =>
    t.db.insert(pullRequests).values({
      repoId,
      number,
      state: 'merged',
      headRef,
      headSha: sha,
      updatedAt: NOW,
      issueRefs,
    });

  it('分支是 fleet/<单号>-t… 且正文挂了这张单：找得到；多个取最新的', async () => {
    const repo = await addRepo(t.db, 'canary');
    await addPr(repo.id, 39, 'fleet/38-t01a10807', [38]);
    await addPr(repo.id, 41, 'fleet/40-t01a10815', [40]);
    await addPr(repo.id, 43, 'fleet/40-t0000beef', [40]);
    expect(await canaryPullRequestNumber(t.db, { repoId: repo.id, issueNumber: 40 })).toBe(43);
    expect(await canaryPullRequestNumber(t.db, { repoId: repo.id, issueNumber: 38 })).toBe(39);
  });

  it('【故意造出的失败】没有这张单的 PR、分支不是引擎的（人手开的）、挂的是别的单、别的仓同号：一律 null，不拿别的冒充', async () => {
    const repo = await addRepo(t.db, 'canary');
    const other = await addRepo(t.db, 'other');
    await addPr(repo.id, 50, 'feature/by-hand', [40]);
    await addPr(repo.id, 51, 'fleet/41-t00000001', [40]);
    await addPr(repo.id, 52, 'fleet/40-t00000002', [41]);
    await addPr(other.id, 53, 'fleet/40-t00000003', [40]);
    expect(await canaryPullRequestNumber(t.db, { repoId: repo.id, issueNumber: 40 })).toBeNull();
    expect(await canaryPullRequestNumber(t.db, { repoId: repo.id, issueNumber: 99 })).toBeNull();
  });
});

describe('老的几轮', () => {
  it('换成三段任务工作流之前记的老步骤（派活、规划）照样读得出来，给人看的名字也在', async () => {
    const { id } = await round();
    await t.db
      .update(canaryRuns)
      .set({ stage: 'dispatch', steps: [{ stage: 'plan', at: NOW.toISOString() }] })
      .where(eq(canaryRuns.id, id));
    const row = await canaryRunById(t.db, id);
    expect(row?.stage).toBe('dispatch');
    expect(CANARY_STAGE_NAMES[row?.stage ?? 'open']).toBe('派活');
    expect(row?.steps.map((s) => CANARY_STAGE_NAMES[s.stage])).toEqual(['规划']);
  });
});
