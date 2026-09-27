import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activeTaskRefs, latestIssueDelivery, mergedPrLedgers } from '../src/queries/reconcile.ts';
import { githubEvents, githubEventVersions, pullRequests, repos } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, DAY, HOUR, MIN } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

describe('每小时对账要的没结束的单（activeTaskRefs）', () => {
  it('没结束的单都列出来（含排队），终态的不列；仓、最近更新、项目接活开没开带着', async () => {
    const aaa = await addRepo(t.db, 'aaa');
    const bbb = await addRepo(t.db, 'bbb');
    await t.db
      .update(repos)
      .set({ autoDispatchSince: ago(DAY) })
      .where(eq(repos.id, aaa.id));
    await addTask(t.db, aaa.id, { issueNumber: 1, state: 'done', updatedAt: ago(HOUR) });
    const running = await addTask(t.db, aaa.id, {
      issueNumber: 2,
      state: 'running',
      updatedAt: ago(2 * HOUR),
    });
    const queued = await addTask(t.db, aaa.id, { issueNumber: 3, state: 'queued' });
    await addTask(t.db, bbb.id, { issueNumber: 4, state: 'failed' });
    const planning = await addTask(t.db, bbb.id, {
      issueNumber: 5,
      state: 'planning',
      updatedAt: ago(MIN),
    });
    await addTask(t.db, bbb.id, { issueNumber: 6, state: 'stopped' });

    const rows = await activeTaskRefs(t.db);
    expect(rows.map((r) => [r.name, r.issueNumber, r.state, r.taskId])).toEqual([
      ['aaa', 2, 'running', running.id],
      ['aaa', 3, 'queued', queued.id],
      ['bbb', 5, 'planning', planning.id],
    ]);
    expect(rows.map((r) => r.owner)).toEqual(['acme', 'acme', 'acme']);
    expect(rows[0]?.updatedAt).toEqual(ago(2 * HOUR));
    expect(rows[1]?.updatedAt).toBeNull();
    expect(rows[2]?.updatedAt).toEqual(ago(MIN));
    expect(rows.map((r) => r.autoDispatch)).toEqual([true, true, false]);
  });
});

async function delivery(
  id: string,
  object: string,
  version: Date,
  over: Partial<typeof githubEvents.$inferInsert> = {},
) {
  await t.db.insert(githubEvents).values({
    deliveryId: id,
    event: 'issues',
    source: 'webhook',
    repo: 'acme/Widgets',
    payload: {},
    status: 'accepted',
    finishedAt: version,
    ...over,
  });
  await t.db.insert(githubEventVersions).values({ deliveryId: id, object, version, state: 'open' });
}

describe('这张 issue 最近一次接活处理过的 issues 投递（latestIssueDelivery）', () => {
  it('按那一版 issue 的时刻取最新的；评论事件、别的 issue 不算；仓名按小写对', async () => {
    await delivery('old', 'acme/widgets:issue:5', ago(2 * HOUR), { note: 'workflow=unscheduled' });
    await delivery('new', 'acme/widgets:issue:5', ago(HOUR), { status: 'waiting', reason: '等上一轮' });
    await delivery('comment', 'acme/widgets:issue:5', ago(MIN), { event: 'issue_comment' });
    await delivery('other', 'acme/widgets:issue:6', ago(MIN));
    const got = await latestIssueDelivery(t.db, { owner: 'acme', name: 'Widgets', issueNumber: 5 });
    expect(got).toMatchObject({
      deliveryId: 'new',
      status: 'waiting',
      reason: '等上一轮',
      note: null,
      issueState: 'open',
    });
    expect(await latestIssueDelivery(t.db, { owner: 'acme', name: 'widgets', issueNumber: 7 })).toBeNull();
  });

  it('门口没收的（外人改了单子）更新也往后排：认接活判过的那一版；只有门口没收的才回它', async () => {
    await delivery('held', 'acme/widgets:issue:5', ago(2 * HOUR), {
      note: 'task=exists, workflow=unscheduled',
    });
    await delivery('edited', 'acme/widgets:issue:5', ago(HOUR), {
      status: 'ignored',
      reason: 'edited_by_outsider',
    });
    await delivery('outsider', 'acme/widgets:issue:6', ago(HOUR), {
      status: 'ignored',
      reason: 'author_not_whitelisted',
    });
    expect(await latestIssueDelivery(t.db, { owner: 'acme', name: 'widgets', issueNumber: 5 })).toMatchObject(
      {
        deliveryId: 'held',
        note: 'task=exists, workflow=unscheduled',
      },
    );
    expect(await latestIssueDelivery(t.db, { owner: 'acme', name: 'widgets', issueNumber: 6 })).toMatchObject(
      {
        deliveryId: 'outsider',
        status: 'ignored',
        reason: 'author_not_whitelisted',
      },
    );
  });
});

describe('合了的 PR 和它对上的单的记账（mergedPrLedgers）', () => {
  it('只列合了的、头分支上有这张单会话的；回看窗口外的点名了才列；只带这条分支上的会话', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-4.9' });
    const route = { id: 'r1' };
    const repo = await addRepo(t.db, 'widgets');
    const task = await addTask(t.db, repo.id, { issueNumber: 160, state: 'merging' });
    const run = await addRun(t.db, { taskId: task.id, routeId: route.id, branch: 'fleet/160-a' });
    const verify = await addRun(t.db, {
      taskId: task.id,
      routeId: route.id,
      branch: 'fleet/160-a',
      stage: 'verify',
    });
    // 同一张单更早一轮（别的分支）、没带分支的会话：不算这条 PR 的账
    await addRun(t.db, { taskId: task.id, routeId: route.id, branch: 'fleet/160-old' });
    await addRun(t.db, { taskId: task.id, routeId: route.id, branch: null });
    const pr = (number: number, headRef: string, state: 'merged' | 'open', updatedAt: Date) =>
      t.db
        .insert(pullRequests)
        .values({ repoId: repo.id, number, state, headRef, headSha: 'a'.repeat(40), updatedAt });
    await pr(1, 'fleet/160-a', 'merged', ago(HOUR));
    await pr(2, 'fleet/160-a', 'open', ago(HOUR));
    await pr(3, 'human/branch', 'merged', ago(HOUR));
    await pr(4, 'fleet/160-a', 'merged', ago(3 * DAY));

    const recent = await mergedPrLedgers(t.db, { since: ago(DAY) });
    expect(recent.map((l) => l.prNumber)).toEqual([1]);
    expect(recent[0]).toMatchObject({
      owner: 'acme',
      name: 'widgets',
      headRef: 'fleet/160-a',
      taskId: task.id,
      issueNumber: 160,
      taskState: 'merging',
      prUpdatedAt: ago(HOUR),
    });
    expect(recent[0]?.sessions.map((s) => s.runId).sort()).toEqual([run.id, verify.id].sort());
    expect(recent[0]?.sessions.every((s) => s.endedAt === null && s.inputTokens === null)).toBe(true);

    const named = await mergedPrLedgers(t.db, {
      since: ago(DAY),
      prs: [{ owner: 'acme', name: 'widgets', number: 4 }],
    });
    expect(named.map((l) => l.prNumber)).toEqual([1, 4]);
    expect(await mergedPrLedgers(t.db, { since: new Date() })).toEqual([]);
  });
});
