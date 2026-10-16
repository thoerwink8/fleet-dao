// 本机领单（决定 0096，queries/local-claims.ts）：领、续、结束、到期收回，状态只用引擎认的那几个；
// 本机的行不进引擎的名额、熔断、失败次数、遗留行对账、「在做几张」。
import { LOCAL_LEASE_MS } from '@fleet-dao/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveTaskSnapshot } from '../src/queries/engine-task-snapshot.ts';
import {
  firstTaskCreatedSince,
  recentEndedTasks,
  taskFailureCount,
  tasksCreatedSince,
} from '../src/queries/intake-history.ts';
import {
  activeLocalLeaseKeys,
  claimLocalTask,
  expiredLocalClaims,
  extendLocalLease,
  finishLocalTask,
  mergedPrForIssue,
  renewLocalTask,
  settleExpiredLocalClaim,
  TAKEOVER_NOTE,
  type TakeOverEngine,
  unexpiredLocalClaims,
} from '../src/queries/local-claims.ts';
import { mergeStallFacts } from '../src/queries/merge-stall.ts';
import { listOpenTaskRows } from '../src/queries/reconcile.ts';
import { auditLog, pullRequests, repos, tasks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, HOUR, later, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const NODE = 'founder-pc';

async function row(repoId: string, issueNumber: number) {
  const [r] = await t.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, issueNumber)));
  return r;
}

describe('claimLocalTask：本机领单', () => {
  it('没有任务行：建一行 running + local，租约 2 小时，记一条操作记录', async () => {
    const repo = await addRepo(t.db, 'app');
    const r = await claimLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 42,
      title: '加验证码',
      nodeId: NODE,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: true, state: 'running', executor: 'local' });
    const got = await row(repo.id, 42);
    expect(got).toMatchObject({ state: 'running', executor: 'local', claimedBy: NODE, title: '加验证码' });
    expect(got?.leaseUntil?.getTime()).toBe(NOW.getTime() + LOCAL_LEASE_MS);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'task.local.claim'));
    expect(audits).toHaveLength(1);
  });

  it('【故意造出的失败】引擎手上的（排队、在跑、停下等人）：不让领，行不动', async () => {
    const repo = await addRepo(t.db, 'app');
    for (const [n, state] of [
      [1, 'queued'],
      [2, 'running'],
      [3, 'stalled'],
    ] as const) {
      await addTask(t.db, repo.id, { issueNumber: n, state });
      const r = await claimLocalTask(t.db, {
        repo: 'acme/app',
        issueNumber: n,
        title: 'x',
        nodeId: NODE,
        now: NOW,
      });
      expect(r).toMatchObject({ ok: false, code: 'engine_has_it' });
      expect(await row(repo.id, n)).toMatchObject({ state, executor: 'engine' });
    }
  });

  it('引擎做完、失败、叫停的：改成本机在做；本机已领着的当续租', async () => {
    const repo = await addRepo(t.db, 'app');
    await addTask(t.db, repo.id, { issueNumber: 5, state: 'stopped' });
    expect(
      await claimLocalTask(t.db, { repo: 'acme/app', issueNumber: 5, title: 'x', nodeId: NODE, now: NOW }),
    ).toMatchObject({ ok: true });
    const again = await claimLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 5,
      title: 'x',
      nodeId: NODE,
      now: later(HOUR),
    });
    expect(again).toMatchObject({ ok: true, leaseUntil: new Date(later(HOUR).getTime() + LOCAL_LEASE_MS) });
    expect(await row(repo.id, 5)).toMatchObject({ state: 'running', executor: 'local' });
  });

  it('【故意造出的失败】仓不归法国管：回 unknown_repo，不建行', async () => {
    const r = await claimLocalTask(t.db, {
      repo: 'acme/nope',
      issueNumber: 1,
      title: 'x',
      nodeId: NODE,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, code: 'unknown_repo' });
  });
});

describe('claimLocalTask：接手引擎已停下的单（stalled / running + parked）', () => {
  const claim = (n: number, takeOver?: TakeOverEngine, now = NOW) =>
    claimLocalTask(t.db, { repo: 'acme/app', issueNumber: n, title: 'x', nodeId: NODE, now, takeOver });

  it('停下的（stalled，或 running + parked）：一步接手，先叫停引擎，改 local、记租约和操作记录（reason 本机接手）', async () => {
    const repo = await addRepo(t.db, 'app');
    await addTask(t.db, repo.id, { issueNumber: 1, state: 'stalled', phase: 'parked', doing: '停着等人' });
    await addTask(t.db, repo.id, { issueNumber: 2, state: 'running', phase: 'parked', doing: '停着等人' });
    const called: number[] = [];
    const takeOver: TakeOverEngine = async (task) => {
      called.push(task.issueNumber);
      return { ok: true };
    };
    for (const n of [1, 2]) {
      expect(await claim(n, takeOver)).toMatchObject({ ok: true, state: 'running', executor: 'local' });
      const got = await row(repo.id, n);
      expect(got).toMatchObject({ state: 'running', executor: 'local', claimedBy: NODE, phase: null });
      expect(got?.leaseUntil?.getTime()).toBe(NOW.getTime() + LOCAL_LEASE_MS);
    }
    expect(called).toEqual([1, 2]);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'task.local.claim'));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ reason: TAKEOVER_NOTE, before: { executor: 'engine' } });
  });

  it('【故意造出的失败】引擎还在跑（running、没停）和排队的：照旧拒，原因写明现在在干什么，不叫停、行不动', async () => {
    const repo = await addRepo(t.db, 'app');
    await addTask(t.db, repo.id, {
      issueNumber: 1,
      state: 'running',
      phase: 'session',
      doing: '会话在写代码',
    });
    await addTask(t.db, repo.id, { issueNumber: 2, state: 'queued' });
    const takeOver = vi.fn<TakeOverEngine>(async () => ({ ok: true }));
    const r = await claim(1, takeOver);
    expect(r).toMatchObject({ ok: false, code: 'engine_has_it' });
    expect(r.ok ? '' : r.why).toContain('会话在写代码');
    expect(await claim(2, takeOver)).toMatchObject({ ok: false, code: 'engine_has_it' });
    expect(takeOver).not.toHaveBeenCalled();
    expect(await row(repo.id, 1)).toMatchObject({ state: 'running', executor: 'engine', phase: 'session' });
  });

  it('【故意造出的失败】叫停没成：整个领单不成、行原样（还是引擎的）、不记操作记录', async () => {
    const repo = await addRepo(t.db, 'app');
    await addTask(t.db, repo.id, { issueNumber: 1, state: 'stalled', phase: 'parked' });
    const r = await claim(1, async () => ({ ok: false, why: '工作流服务暂时连不上' }));
    expect(r).toMatchObject({ ok: false, code: 'engine_has_it' });
    expect(r.ok ? '' : r.why).toContain('工作流服务暂时连不上');
    expect(await row(repo.id, 1)).toMatchObject({ state: 'stalled', executor: 'engine' });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('接手后引擎不再拉这张单：收尾的 stopped 快照写不回去，遗留行对账不列；租约到期照常退回法国', async () => {
    const repo = await addRepo(t.db, 'app');
    const task = await addTask(t.db, repo.id, { issueNumber: 1, state: 'stalled', phase: 'parked' });
    await claim(1, async () => ({ ok: true }));
    // 引擎工作流收到 taskAbandon 后收尾，写 stopped 快照：不能把本机的行改回去
    const snap = await saveTaskSnapshot(t.db, {
      taskId: task.id,
      state: 'stopped',
      phase: 'abandoned',
      doing: '被 node:founder-pc 放弃：本机接手',
      lastProblem: '本机接手',
      subtasks: [],
    });
    expect(snap).toBe('held_by_local');
    expect(await row(repo.id, 1)).toMatchObject({ state: 'running', executor: 'local', claimedBy: NODE });
    expect((await listOpenTaskRows(t.db)).map((r) => r.issueNumber)).not.toContain(1);
    const [expired] = await expiredLocalClaims(t.db, repo.id, later(LOCAL_LEASE_MS + HOUR));
    expect(expired?.issueNumber).toBe(1);
    await settleExpiredLocalClaim(t.db, {
      taskId: task.id,
      how: 'returned',
      why: '到期',
      now: later(LOCAL_LEASE_MS + HOUR),
    });
    expect(await row(repo.id, 1)).toMatchObject({ state: 'stopped', executor: 'engine' });
  });

  it('接手后单关、PR 合了：提前收成 done，照常', async () => {
    const repo = await addRepo(t.db, 'app');
    const task = await addTask(t.db, repo.id, { issueNumber: 1, state: 'stalled', phase: 'parked' });
    await claim(1, async () => ({ ok: true }));
    expect(
      await settleExpiredLocalClaim(t.db, {
        taskId: task.id,
        how: 'done',
        why: 'PR 合了',
        now: NOW,
        early: true,
      }),
    ).toBe(1);
    expect(await row(repo.id, 1)).toMatchObject({ state: 'done', executor: 'local' });
  });
});

describe('renew / finish', () => {
  it('续租顺延；做完记 done；放手退回 stopped + engine（拉单能接手）；没做成记 failed（还是本机的账）', async () => {
    const repo = await addRepo(t.db, 'app');
    for (const n of [1, 2, 3]) {
      await claimLocalTask(t.db, { repo: 'acme/app', issueNumber: n, title: 'x', nodeId: NODE, now: NOW });
    }
    expect(
      await renewLocalTask(t.db, { repo: 'acme/app', issueNumber: 1, nodeId: NODE, now: later(HOUR) }),
    ).toMatchObject({ ok: true });
    await finishLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 1,
      outcome: 'done',
      nodeId: NODE,
      now: NOW,
    });
    await finishLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 2,
      outcome: 'released',
      reason: '要法国做',
      nodeId: NODE,
      now: NOW,
    });
    await finishLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 3,
      outcome: 'failed',
      reason: '测不过',
      nodeId: NODE,
      now: NOW,
    });
    expect(await row(repo.id, 1)).toMatchObject({ state: 'done', executor: 'local', leaseUntil: null });
    expect(await row(repo.id, 2)).toMatchObject({
      state: 'stopped',
      executor: 'engine',
      claimedBy: null,
      lastProblem: '要法国做',
    });
    expect(await row(repo.id, 3)).toMatchObject({
      state: 'failed',
      executor: 'local',
      lastProblem: '测不过',
    });
  });

  it('【故意造出的失败】不是本机在做的：续不了、结束不了，回 not_claimed', async () => {
    const repo = await addRepo(t.db, 'app');
    await addTask(t.db, repo.id, { issueNumber: 9, state: 'running' });
    expect(
      await renewLocalTask(t.db, { repo: 'acme/app', issueNumber: 9, nodeId: NODE, now: NOW }),
    ).toMatchObject({
      ok: false,
      code: 'not_claimed',
    });
    expect(
      await finishLocalTask(t.db, {
        repo: 'acme/app',
        issueNumber: 9,
        outcome: 'done',
        nodeId: NODE,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'not_claimed' });
    expect(await row(repo.id, 9)).toMatchObject({ state: 'running', executor: 'engine' });
  });
});

describe('到期收回', () => {
  it('列出过期的；顺延后不再列；收回只动仍过期的本机行', async () => {
    const repo = await addRepo(t.db, 'app');
    await claimLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 1,
      title: 'x',
      nodeId: NODE,
      now: ago(3 * HOUR),
    });
    await claimLocalTask(t.db, { repo: 'acme/app', issueNumber: 2, title: 'x', nodeId: NODE, now: NOW });
    const expired = await expiredLocalClaims(t.db, repo.id, NOW);
    expect(expired.map((e) => e.issueNumber)).toEqual([1]);
    const first = expired[0];
    if (!first) throw new Error('没列出来');

    await extendLocalLease(t.db, first.taskId, later(HOUR));
    expect(await expiredLocalClaims(t.db, repo.id, NOW)).toEqual([]);
    expect(
      await settleExpiredLocalClaim(t.db, { taskId: first.taskId, how: 'returned', why: 'x', now: NOW }),
    ).toBe(0);

    const late = later(2 * HOUR);
    expect(
      await settleExpiredLocalClaim(t.db, { taskId: first.taskId, how: 'returned', why: '到期', now: late }),
    ).toBe(1);
    expect(await row(repo.id, 1)).toMatchObject({ state: 'stopped', executor: 'engine', leaseUntil: null });
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'task.local.expire'));
    expect(audits).toHaveLength(1);
  });

  it('单已关：有合并的 PR 记 done（还是本机的账）', async () => {
    const repo = await addRepo(t.db, 'app');
    await claimLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 3,
      title: 'x',
      nodeId: NODE,
      now: ago(3 * HOUR),
    });
    const [e] = await expiredLocalClaims(t.db, repo.id, NOW);
    if (!e) throw new Error('没列出来');
    expect(
      await settleExpiredLocalClaim(t.db, { taskId: e.taskId, how: 'done', why: 'PR 合了', now: NOW }),
    ).toBe(1);
    expect(await row(repo.id, 3)).toMatchObject({ state: 'done', executor: 'local' });
  });

  it('没到期的租约：unexpiredLocalClaims 列出；early 收成 done 不看租约时刻，不带 early 不动', async () => {
    const repo = await addRepo(t.db, 'app');
    await claimLocalTask(t.db, { repo: 'acme/app', issueNumber: 5, title: 'x', nodeId: NODE, now: NOW });
    const [u] = await unexpiredLocalClaims(t.db, repo.id, NOW);
    expect(u?.issueNumber).toBe(5);
    if (!u) throw new Error('没列出来');
    expect(await expiredLocalClaims(t.db, repo.id, NOW)).toEqual([]);
    expect(await settleExpiredLocalClaim(t.db, { taskId: u.taskId, how: 'done', why: 'x', now: NOW })).toBe(
      0,
    );
    expect(
      await settleExpiredLocalClaim(t.db, {
        taskId: u.taskId,
        how: 'done',
        why: 'PR 合了',
        now: NOW,
        early: true,
      }),
    ).toBe(1);
    expect(await row(repo.id, 5)).toMatchObject({ state: 'done', executor: 'local', leaseUntil: null });
    expect(await unexpiredLocalClaims(t.db, repo.id, NOW)).toEqual([]);
  });

  it('mergedPrForIssue：需求栏挂着、或固定前缀分支的合并 PR；开着的不算', async () => {
    const repo = await addRepo(t.db, 'app');
    const pr = (number: number, headRef: string, state: 'open' | 'merged', issueRefs: number[] = []) =>
      t.db.insert(pullRequests).values({
        repoId: repo.id,
        number,
        state,
        headRef,
        headSha: 'a'.repeat(40),
        updatedAt: NOW,
        issueRefs,
      });
    await pr(10, 'feat/x', 'merged', [7]);
    await pr(11, 'local/8-y', 'merged');
    await pr(12, 'local/9-z', 'open');
    expect(await mergedPrForIssue(t.db, repo.id, 7)).toBe(10);
    expect(await mergedPrForIssue(t.db, repo.id, 8)).toBe(11);
    expect(await mergedPrForIssue(t.db, repo.id, 9)).toBeNull();
    expect(await mergedPrForIssue(t.db, repo.id, 80)).toBeNull();
  });
});

describe('activeLocalLeaseKeys：还没到期的本机租约', () => {
  it('刚领的在里面；过了到期时刻的不在；做完的不在', async () => {
    await addRepo(t.db, 'app');
    await claimLocalTask(t.db, { repo: 'acme/app', issueNumber: 5, title: 'x', nodeId: NODE, now: NOW });
    expect(await activeLocalLeaseKeys(t.db, NOW)).toEqual(new Set(['acme/app#5']));
    expect(await activeLocalLeaseKeys(t.db, new Date(NOW.getTime() + LOCAL_LEASE_MS))).toEqual(
      new Set(['acme/app#5']),
    );
    expect(await activeLocalLeaseKeys(t.db, new Date(NOW.getTime() + LOCAL_LEASE_MS + 1))).toEqual(new Set());
    await finishLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 5,
      outcome: 'done',
      nodeId: NODE,
      now: NOW,
    });
    expect(await activeLocalLeaseKeys(t.db, NOW)).toEqual(new Set());
  });
});

describe('本机的行不算引擎的账（#2159 只认引擎会写的状态，谁在做另记）', () => {
  it('滚动一小时起了几条、熔断试探、最近结束的、失败次数、遗留行对账、在做几张：都不数本机的行', async () => {
    const repo = await addRepo(t.db, 'app');
    await t.db
      .update(repos)
      .set({ autoDispatchSince: ago(48 * HOUR) })
      .where(eq(repos.id, repo.id));
    await claimLocalTask(t.db, { repo: 'acme/app', issueNumber: 1, title: 'x', nodeId: NODE, now: NOW });
    await claimLocalTask(t.db, { repo: 'acme/app', issueNumber: 2, title: 'x', nodeId: NODE, now: NOW });
    await finishLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 2,
      outcome: 'failed',
      nodeId: NODE,
      now: NOW,
    });

    expect(await tasksCreatedSince(t.db, ago(HOUR))).toBe(0);
    expect(await firstTaskCreatedSince(t.db, ago(HOUR))).toBeNull();
    expect(await recentEndedTasks(t.db, { limit: 6 })).toEqual([]);
    expect(await taskFailureCount(t.db, repo.id, 2)).toBe(0);
    expect(await listOpenTaskRows(t.db)).toEqual([]);
    const facts = await mergeStallFacts(t.db);
    expect(facts.repos[0]?.inFlight).toBe(0);

    // 引擎的行照数
    await addTask(t.db, repo.id, { issueNumber: 3, state: 'running', createdAt: NOW });
    expect((await listOpenTaskRows(t.db)).map((r) => r.issueNumber)).toEqual([3]);
    expect((await mergeStallFacts(t.db)).repos[0]?.inFlight).toBe(1);
  });
});
