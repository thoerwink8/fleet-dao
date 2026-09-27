// 每小时对账要的提醒查询和工作树查询：撤提醒写明为什么、进操作记录；再提醒一天一条、不把人处理掉的又打开；
// 只改还开着的；没处理的列不全照实说。工作树：一棵树是哪张需求的、分支推上去过哪些头、「工作树没收掉」说的是哪棵树、
// 哪些目录里还有没结束的会话。
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alertByKey,
  insertAlertOnce,
  latestAlertByPrefix,
  listOpenAlerts,
  resolveAlertWithReason,
  updateOpenAlert,
} from '../src/queries/alerts.ts';
import { upsertAlert } from '../src/queries/engine.ts';
import {
  issueWorkFacts,
  openSessionTrees,
  prHeadsOfBranch,
  subtaskTreeRefs,
  taskStateOf,
} from '../src/queries/worktrees.ts';
import { auditLog, notifications, pullRequests } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addSubtask, addTask, ago, catalog, later, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const alert = (dedupeKey: string, body = '原来的正文') =>
  upsertAlert(t.db, { dedupeKey, level: 'alert', taskId: null, title: dedupeKey, body });

describe('resolveAlertWithReason', () => {
  it('撤掉：记处理人、正文开头写「已撤：为什么」，同一事务里记一条操作记录', async () => {
    const { id } = await alert('sub:1:worktree');
    expect(
      await resolveAlertWithReason(t.db, {
        dedupeKey: 'sub:1:worktree',
        by: 'engine:hourly-reconcile',
        why: '树已经不在了',
        at: NOW,
      }),
    ).toBe('ok');
    const row = await alertByKey(t.db, 'sub:1:worktree');
    expect(row).toMatchObject({ resolvedBy: 'engine:hourly-reconcile', resolvedAt: NOW });
    expect(row?.body).toBe('已撤：树已经不在了\n\n原来的正文');
    const audits = await t.db.select().from(auditLog);
    expect(audits).toEqual([
      expect.objectContaining({
        actorKind: 'engine',
        actorId: 'engine:hourly-reconcile',
        action: 'notification.resolve',
        target: `notification:${id}`,
        reason: '树已经不在了',
        via: 'engine',
        ok: true,
      }),
    ]);
  });

  it('处理人和做事的分开记：人在再提醒上点了处理，处理人记那个人，操作记录记是引擎做的', async () => {
    await alert('x:1', '');
    await resolveAlertWithReason(t.db, {
      dedupeKey: 'x:1',
      by: 'founder-a',
      auditActor: 'engine:hourly-reconcile',
      why: '人在再提醒上点了处理',
    });
    expect(await alertByKey(t.db, 'x:1')).toMatchObject({
      resolvedBy: 'founder-a',
      body: '已撤：人在再提醒上点了处理',
    });
    expect((await t.db.select().from(auditLog))[0]).toMatchObject({ actorId: 'engine:hourly-reconcile' });
  });

  it('已经处理过的不动（不改处理人、不再记操作）；没有这条回 not_found；没写为什么明确拒', async () => {
    await alert('x:2');
    await resolveAlertWithReason(t.db, { dedupeKey: 'x:2', by: 'founder-a', why: '人处理了', at: NOW });
    expect(
      await resolveAlertWithReason(t.db, {
        dedupeKey: 'x:2',
        by: 'engine:hourly-reconcile',
        why: '又撤一次',
      }),
    ).toBe('already_resolved');
    expect(await alertByKey(t.db, 'x:2')).toMatchObject({ resolvedBy: 'founder-a', resolvedAt: NOW });
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
    expect(await resolveAlertWithReason(t.db, { dedupeKey: 'nope', by: 'e', why: 'x' })).toBe('not_found');
    await expect(resolveAlertWithReason(t.db, { dedupeKey: 'x:2', by: 'e', why: '  ' })).rejects.toThrow(
      '没写为什么',
    );
  });
});

describe('insertAlertOnce', () => {
  it('没有就建；有了（开着、处理过都算）一概不动，不把人处理掉的那条又打开', async () => {
    const input = {
      dedupeKey: 'remind:abc:2026-09-26',
      level: 'alert' as const,
      taskId: null,
      title: '还没处理：卡住了',
      body: '再提醒',
      link: '/tasks/1',
    };
    const first = await insertAlertOnce(t.db, input);
    expect(first.created).toBe(true);
    expect(await insertAlertOnce(t.db, { ...input, title: '改了' })).toEqual({
      id: first.id,
      created: false,
    });
    await t.db
      .update(notifications)
      .set({ resolvedAt: NOW, resolvedBy: 'founder-a' })
      .where(eq(notifications.id, first.id));
    expect(await insertAlertOnce(t.db, input)).toEqual({ id: first.id, created: false });
    expect(await alertByKey(t.db, input.dedupeKey)).toMatchObject({
      title: '还没处理：卡住了',
      link: '/tasks/1',
      resolvedBy: 'founder-a',
    });
  });
});

describe('updateOpenAlert', () => {
  it('只改开着的；处理掉的不替人打开，回 not_open；什么都没给明确拒', async () => {
    await alert('park:1');
    expect(await updateOpenAlert(t.db, { dedupeKey: 'park:1', body: '路由已经恢复……' })).toBe('ok');
    expect(await alertByKey(t.db, 'park:1')).toMatchObject({ body: '路由已经恢复……', resolvedAt: null });
    await resolveAlertWithReason(t.db, { dedupeKey: 'park:1', by: 'founder-a', why: '人处理了' });
    expect(await updateOpenAlert(t.db, { dedupeKey: 'park:1', title: '又改' })).toBe('not_open');
    expect(await alertByKey(t.db, 'park:1')).toMatchObject({ title: 'park:1', resolvedBy: 'founder-a' });
    expect(await updateOpenAlert(t.db, { dedupeKey: 'nope', body: 'x' })).toBe('not_open');
    await expect(updateOpenAlert(t.db, { dedupeKey: 'park:1' })).rejects.toThrow('什么都没给');
  });
});

describe('listOpenAlerts / latestAlertByPrefix', () => {
  it('没处理的老的在前；多出上限的照实回 truncated，不当成只有这么多', async () => {
    for (const key of ['a', 'b', 'c']) await alert(key);
    await resolveAlertWithReason(t.db, { dedupeKey: 'b', by: 'e', why: 'x' });
    expect((await listOpenAlerts(t.db, { limit: 5 })).alerts.map((a) => a.dedupeKey)).toEqual(['a', 'c']);
    expect(await listOpenAlerts(t.db, { limit: 1 })).toMatchObject({
      truncated: true,
      alerts: [{ dedupeKey: 'a' }],
    });
    await expect(listOpenAlerts(t.db, { limit: 0 })).rejects.toThrow('正整数');
  });

  it('前缀对上的最新一条（处理过的也算）；前缀逐字比、空前缀明确拒', async () => {
    await insertAlertOnce(t.db, {
      dedupeKey: 'remind:n1:2026-09-25',
      level: 'alert',
      taskId: null,
      title: '1',
      body: '',
    });
    await t.db
      .update(notifications)
      .set({ createdAt: new Date(NOW.getTime() - 60 * MIN) })
      .where(eq(notifications.dedupeKey, 'remind:n1:2026-09-25'));
    await insertAlertOnce(t.db, {
      dedupeKey: 'remind:n1:2026-09-26',
      level: 'alert',
      taskId: null,
      title: '2',
      body: '',
    });
    await resolveAlertWithReason(t.db, { dedupeKey: 'remind:n1:2026-09-26', by: 'founder-a', why: '处理了' });
    await insertAlertOnce(t.db, {
      dedupeKey: 'remind:n10:2026-09-27',
      level: 'alert',
      taskId: null,
      title: '3',
      body: '',
    });
    expect(await latestAlertByPrefix(t.db, 'remind:n1:')).toMatchObject({
      dedupeKey: 'remind:n1:2026-09-26',
      resolvedBy: 'founder-a',
    });
    expect(await latestAlertByPrefix(t.db, 'remind:n2:')).toBeNull();
    await expect(latestAlertByPrefix(t.db, '')).rejects.toThrow('空');
  });
});

describe('工作树对账要的查询', () => {
  it('某个仓某张 issue 的需求、状态和全部子任务（含作废的）；没有这张需求回 null', async () => {
    const repo = await addRepo(t.db, 'widgets');
    const task = await addTask(t.db, repo.id, { issueNumber: 160, state: 'failed' });
    const a = await addSubtask(t.db, task.id, { key: 'login', index: 0 });
    const old = await addSubtask(t.db, task.id, { key: 'login', index: 1, supersededAt: NOW });
    const facts = await issueWorkFacts(t.db, { owner: 'acme', name: 'widgets', issueNumber: 160 });
    expect(facts).toMatchObject({ taskId: task.id, state: 'failed' });
    expect(facts?.subtasks.map((s) => s.id).sort()).toEqual([a.id, old.id].sort());
    expect(await issueWorkFacts(t.db, { owner: 'acme', name: 'widgets', issueNumber: 161 })).toBeNull();
    expect(await issueWorkFacts(t.db, { owner: 'other', name: 'widgets', issueNumber: 160 })).toBeNull();
    expect(await taskStateOf(t.db, task.id)).toBe('failed');
    expect(await taskStateOf(t.db, randomUUID())).toBeNull();
    expect(await taskStateOf(t.db, 'not-a-uuid')).toBeNull();
  });

  it('分支推上去过的头：这个仓这条分支的 PR（开着、关了、合了都算），别的仓、别的分支不算', async () => {
    const repo = await addRepo(t.db, 'widgets');
    const other = await addRepo(t.db, 'gadgets');
    const pr = (repoId: string, number: number, headRef: string, headSha: string, state: 'open' | 'merged') =>
      t.db.insert(pullRequests).values({ repoId, number, state, headRef, headSha, updatedAt: later(MIN) });
    await pr(repo.id, 1, 'fleet/160-login', 'a'.repeat(40), 'merged');
    await pr(repo.id, 2, 'fleet/160-login', 'b'.repeat(40), 'open');
    await pr(repo.id, 3, 'fleet/160-other', 'c'.repeat(40), 'open');
    await pr(other.id, 4, 'fleet/160-login', 'd'.repeat(40), 'open');
    expect(
      (await prHeadsOfBranch(t.db, { owner: 'acme', name: 'widgets', branch: 'fleet/160-login' })).sort(),
    ).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(await prHeadsOfBranch(t.db, { owner: 'acme', name: 'widgets', branch: 'fleet/9-x' })).toEqual([]);
  });

  it('没结束的会话起在哪些目录：结束了的、没记目录的不算', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-4.9' });
    const repo = await addRepo(t.db, 'widgets');
    const task = await addTask(t.db, repo.id, { issueNumber: 160 });
    const open = await addRun(t.db, {
      taskId: task.id,
      routeId: 'r1',
      worktreePath: '/w/acme_widgets/160-a',
    });
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'r1',
      worktreePath: '/w/acme_widgets/160.plan',
      startedAt: ago(20 * MIN),
      endedAt: ago(10 * MIN),
      outcome: 'ok',
    });
    await addRun(t.db, { taskId: null, routeId: 'r1', stage: 'triage' });
    expect(await openSessionTrees(t.db)).toEqual([
      { runId: open.id, stage: 'execute', queuedAt: open.queuedAt, path: '/w/acme_widgets/160-a' },
    ]);
  });

  it('子任务编号 → 树在哪个仓、哪张 issue、哪个 key；库里没有的、不是 UUID 的不在结果里', async () => {
    const repo = await addRepo(t.db, 'widgets');
    const task = await addTask(t.db, repo.id, { issueNumber: 160 });
    const sub = await addSubtask(t.db, task.id, { key: 'login' });
    expect(await subtaskTreeRefs(t.db, [sub.id, randomUUID(), 'nope'])).toEqual([
      { subtaskId: sub.id, taskId: task.id, owner: 'acme', name: 'widgets', issueNumber: 160, key: 'login' },
    ]);
    expect(await subtaskTreeRefs(t.db, [])).toEqual([]);
  });
});
