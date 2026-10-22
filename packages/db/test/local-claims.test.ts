// 本机领单（决定 0096，queries/local-claims.ts）：领、续、结束、到期收回，状态只用引擎认的那几个；
// 本机的行不进引擎的名额、熔断、失败次数、遗留行对账、「在做几张」。
import { randomUUID } from 'node:crypto';
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
  confirmLocalTakeover,
  expiredLocalClaims,
  extendLocalLease,
  finishLocalTask,
  lastLocalReturnAt,
  listLocalClaims,
  mergedPrForIssue,
  type ReadWorkflow,
  renewLocalTask,
  type SignalRun,
  settleExpiredLocalClaim,
  TAKEOVER_NOTE,
  type TakeOverEngine,
  unexpiredLocalClaims,
} from '../src/queries/local-claims.ts';
import { mergeStallFacts } from '../src/queries/merge-stall.ts';
import { listOpenTaskRows } from '../src/queries/reconcile.ts';
import { auditLog, pullRequests, repos, runs, taskExecutionOperations, tasks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, HOUR, later, NOW } from './helpers.ts';

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

describe('受管接手已有 PR 的停下的单（takeoverPr + confirmLocalTakeover）', () => {
  const HEAD = 'a'.repeat(40);
  const wf = { ok: true as const, workflowId: 'task-acme-app-1', runId: 'run-1', running: true };
  let running = true;
  let readResult: Awaited<ReturnType<ReadWorkflow>> = wf;
  const signals: string[] = [];
  const readWorkflow: ReadWorkflow = async () => (readResult.ok ? { ...readResult, running } : readResult);
  const signalRun = vi.fn<SignalRun>(async (_t, run) => {
    signals.push(run.runId);
    return { ok: true };
  });
  beforeEach(() => {
    running = true;
    readResult = wf;
    signals.length = 0;
    signalRun.mockClear();
    signalRun.mockImplementation(async (_t, run) => {
      signals.push(run.runId);
      return { ok: true };
    });
  });
  const takeoverPr = (over: { pr?: number; head?: string } = {}) => ({
    pr: 50,
    head: HEAD,
    readWorkflow,
    signalRun,
    ...over,
  });
  const claim = (n: number, over: { pr?: number; head?: string } = {}, node = NODE, now = NOW) =>
    claimLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: n,
      title: 'x',
      nodeId: node,
      now,
      takeoverPr: takeoverPr(over),
    });
  const confirm = (n: number, over: { pr?: number; head?: string } = {}, now = NOW) =>
    confirmLocalTakeover(t.db, {
      repo: 'acme/app',
      issueNumber: n,
      nodeId: NODE,
      now,
      pr: over.pr ?? 50,
      head: over.head ?? HEAD,
      readWorkflow,
    });
  async function world(over: { headRef?: string; headSha?: string } = {}) {
    const repo = await addRepo(t.db, 'app');
    const task = await addTask(t.db, repo.id, { issueNumber: 1, state: 'running', phase: 'parked' });
    await t.db.insert(pullRequests).values({
      repoId: repo.id,
      number: 50,
      state: 'open',
      headRef: over.headRef ?? 'fleet/1-tabcdef12',
      headSha: over.headSha ?? HEAD,
      updatedAt: NOW,
      issueRefs: [1],
    });
    return { repo, task };
  }

  it('成功：先登记（信号只发给读到的精确 run、记原 PR/head/run），工作流还在跑时 confirm 是 pending，终态后才 ok', async () => {
    const { repo, task } = await world();
    expect(await claim(1)).toMatchObject({ ok: true, executor: 'local' });
    expect(signals).toEqual(['run-1']);
    expect(await row(repo.id, 1)).toMatchObject({ state: 'running', executor: 'local', claimedBy: NODE });
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'task.local.claim'));
    expect(audit?.after).toMatchObject({
      takeover: { pr: 50, head: HEAD, workflowId: 'task-acme-app-1', runId: 'run-1' },
    });
    // 信号受理不是交接完成
    expect(await confirm(1)).toMatchObject({ ok: false, code: 'takeover_pending' });
    running = false;
    expect(await confirm(1)).toMatchObject({ ok: true, executor: 'local' });
    // 引擎晚到的收尾快照写不回去
    expect(
      await saveTaskSnapshot(t.db, {
        taskId: task.id,
        state: 'stopped',
        phase: 'abandoned',
        doing: '放弃',
        lastProblem: null,
        subtasks: [],
      }),
    ).toBe('held_by_local');
    expect(await row(repo.id, 1)).toMatchObject({ executor: 'local', state: 'running' });
    // 确认可重复，不重复记账
    expect(await confirm(1)).toMatchObject({ ok: true });
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'task.local.takeover_confirm')),
    ).toHaveLength(1);
  });

  it('【故意造出的失败】PR 对不上：换头、串号、多 PR、非引擎分支、没有 PR：全拒，行原样，不发信号', async () => {
    const { repo } = await world();
    expect(await claim(1, { head: 'b'.repeat(40) })).toMatchObject({ ok: false, code: 'takeover_refused' });
    expect(await claim(1, { pr: 51 })).toMatchObject({ ok: false, code: 'takeover_refused' });
    await t.db.insert(pullRequests).values({
      repoId: repo.id,
      number: 51,
      state: 'open',
      headRef: 'local/1-x',
      headSha: 'c'.repeat(40),
      updatedAt: NOW,
    });
    const multi = await claim(1);
    expect(multi).toMatchObject({ ok: false, code: 'takeover_refused' });
    expect(multi.ok ? '' : multi.why).toContain('2 个');
    expect(signals).toEqual([]);
    expect(await row(repo.id, 1)).toMatchObject({ executor: 'engine', phase: 'parked' });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('【故意造出的失败】分支不是 fleet/<单号>-、PR 不在本仓镜像里：拒', async () => {
    await world({ headRef: 'local/1-hand' });
    expect(await claim(1)).toMatchObject({ ok: false, code: 'takeover_refused' });
    const other = await addRepo(t.db, 'other');
    await addTask(t.db, other.id, { issueNumber: 1, state: 'running', phase: 'parked' });
    // 另一个仓的 PR 不算本仓的
    expect(
      await claimLocalTask(t.db, {
        repo: 'acme/other',
        issueNumber: 1,
        title: 'x',
        nodeId: NODE,
        now: NOW,
        takeoverPr: takeoverPr(),
      }),
    ).toMatchObject({ ok: false, code: 'takeover_refused' });
  });

  it('【故意造出的失败】活工人（未结束的 run）和未结清的受管执行操作：拒，不放弃、不发信号', async () => {
    const { repo, task } = await world();
    await catalog(t.db);
    await addRoute(t.db, { id: 'a-opus', poolId: 'relay-a', modelId: 'opus-4.9' });
    const live = await addRun(t.db, { taskId: task.id, routeId: 'a-opus', startedAt: ago(HOUR) });
    expect(await claim(1)).toMatchObject({ ok: false, code: 'takeover_refused' });
    await t.db
      .update(runs)
      .set({ endedAt: ago(1), outcome: 'done' })
      .where(eq(runs.id, live.id));
    await t.db.insert(taskExecutionOperations).values({
      id: randomUUID(),
      taskId: task.id,
      coverageEpoch: randomUUID(),
      revision: 1,
      requestId: randomUUID(),
      nodeId: 'engine',
      kind: 'redo',
      namespace: 'default',
      workflowId: 'w',
      generation: 2,
      workflowType: 'taskWorkflow',
      inputHash: 'h',
      phase: 'reserved',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const r = await claim(1);
    expect(r).toMatchObject({ ok: false, code: 'takeover_refused' });
    expect(r.ok ? '' : r.why).toContain('持久协调边界');
    expect(signals).toEqual([]);
    expect(await row(repo.id, 1)).toMatchObject({ executor: 'engine' });
  });

  it('【故意造出的失败】引擎没停下（在跑）：拒；读不到工作流身份：拒；叫停没成：行原样、重跑可恢复', async () => {
    const repo = await addRepo(t.db, 'app');
    await addTask(t.db, repo.id, { issueNumber: 1, state: 'running', phase: 'session' });
    await t.db.insert(pullRequests).values({
      repoId: repo.id,
      number: 50,
      state: 'open',
      headRef: 'fleet/1-t',
      headSha: HEAD,
      updatedAt: NOW,
      issueRefs: [1],
    });
    expect(await claim(1)).toMatchObject({ ok: false, code: 'takeover_refused' });
    await t.db.update(tasks).set({ phase: 'parked' }).where(eq(tasks.issueNumber, 1));
    readResult = { ok: false, why: '连不上' };
    expect(await claim(1)).toMatchObject({ ok: false, code: 'takeover_refused' });
    readResult = wf;
    signalRun.mockImplementationOnce(async () => ({ ok: false, why: '断线' }));
    expect(await claim(1)).toMatchObject({ ok: false, code: 'engine_has_it' });
    expect(await row(repo.id, 1)).toMatchObject({ executor: 'engine', phase: 'parked' });
    // 重跑：恢复
    expect(await claim(1)).toMatchObject({ ok: true });
  });

  it('重入：同一次接手只续租，不再发信号、不新增 claim 记录；别的节点、别的 head 不能覆盖赢家', async () => {
    const { repo } = await world();
    await claim(1);
    signals.length = 0;
    const again = await claim(1, {}, NODE, later(HOUR));
    expect(again).toMatchObject({ ok: true });
    expect(again.ok && again.leaseUntil?.getTime()).toBe(later(HOUR).getTime() + LOCAL_LEASE_MS);
    expect(signals).toEqual([]);
    expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'task.local.claim'))).toHaveLength(1);
    expect(await claim(1, {}, 'other-pc')).toMatchObject({ ok: false, code: 'takeover_refused' });
    expect(await row(repo.id, 1)).toMatchObject({ claimedBy: NODE });
    // 租约到期：confirm 不算数
    expect(await confirm(1, {}, later(LOCAL_LEASE_MS + 2 * HOUR))).toMatchObject({
      ok: false,
      code: 'takeover_refused',
    });
  });

  it('确认时：PR 换头、工作流 run 变了、未结束 run 重现、读不到：不宣称完成', async () => {
    const { task } = await world();
    await claim(1);
    running = false;
    expect(await confirm(1, { head: 'd'.repeat(40) })).toMatchObject({ ok: false, code: 'takeover_refused' });
    await t.db
      .update(pullRequests)
      .set({ headSha: 'e'.repeat(40) })
      .where(eq(pullRequests.number, 50));
    expect(await confirm(1)).toMatchObject({ ok: false, code: 'takeover_refused' });
    await t.db.update(pullRequests).set({ headSha: HEAD }).where(eq(pullRequests.number, 50));
    readResult = { ...wf, runId: 'run-2' };
    expect(await confirm(1)).toMatchObject({ ok: false, code: 'takeover_refused' });
    readResult = { ok: false, why: '断线' };
    expect(await confirm(1)).toMatchObject({ ok: false, code: 'takeover_pending' });
    readResult = wf;
    await catalog(t.db);
    await addRoute(t.db, { id: 'a-opus', poolId: 'relay-a', modelId: 'opus-4.9' });
    await addRun(t.db, { taskId: task.id, routeId: 'a-opus', startedAt: ago(1) });
    expect(await confirm(1)).toMatchObject({ ok: false, code: 'takeover_pending' });
  });

  it('引擎已 stopped 且工作流已结束：不发信号也能接手；stopped 但工作流还在跑：拒', async () => {
    const { repo } = await world();
    await t.db.update(tasks).set({ state: 'stopped', phase: null }).where(eq(tasks.issueNumber, 1));
    expect(await claim(1)).toMatchObject({ ok: false, code: 'takeover_refused' });
    running = false;
    expect(await claim(1)).toMatchObject({ ok: true });
    expect(signals).toEqual([]);
    expect(await row(repo.id, 1)).toMatchObject({ executor: 'local' });
  });

  it('普通 claim（不带 takeoverPr）对这类单行为不变：停下的照旧接手', async () => {
    await world();
    expect(
      await claimLocalTask(t.db, {
        repo: 'acme/app',
        issueNumber: 1,
        title: 'x',
        nodeId: NODE,
        now: NOW,
        takeOver: async () => ({ ok: true }),
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('lastLocalReturnAt：最近一次退回法国队列的时刻（#3461，读操作记录，不加列）', () => {
  const claimAt = (issueNumber: number, now: Date) =>
    claimLocalTask(t.db, { repo: 'acme/app', issueNumber, title: 'x', nodeId: NODE, now });

  it('租约到期退回（expire + returned）：回退回那一刻', async () => {
    const repo = await addRepo(t.db, 'app');
    const task = await addTask(t.db, repo.id, { issueNumber: 1, state: 'failed' });
    await claimAt(1, NOW);
    const at = later(LOCAL_LEASE_MS + HOUR);
    await settleExpiredLocalClaim(t.db, { taskId: task.id, how: 'returned', why: '到期', now: at });
    expect((await lastLocalReturnAt(t.db, task.id))?.getTime()).toBe(at.getTime());
  });

  it('本机放手（finish + released）：回放手那一刻', async () => {
    const repo = await addRepo(t.db, 'app');
    const task = await addTask(t.db, repo.id, { issueNumber: 1, state: 'failed' });
    await claimAt(1, NOW);
    const at = later(HOUR);
    await finishLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 1,
      outcome: 'released',
      reason: '要法国做',
      nodeId: NODE,
      now: at,
    });
    expect((await lastLocalReturnAt(t.db, task.id))?.getTime()).toBe(at.getTime());
  });

  it('退回过好几次：取最近一次', async () => {
    const repo = await addRepo(t.db, 'app');
    const task = await addTask(t.db, repo.id, { issueNumber: 1, state: 'failed' });
    await claimAt(1, NOW);
    await finishLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 1,
      outcome: 'released',
      nodeId: NODE,
      now: later(HOUR),
    });
    await claimAt(1, later(2 * HOUR));
    const last = later(LOCAL_LEASE_MS + 3 * HOUR);
    await settleExpiredLocalClaim(t.db, { taskId: task.id, how: 'returned', why: '到期', now: last });
    expect((await lastLocalReturnAt(t.db, task.id))?.getTime()).toBe(last.getTime());
  });

  it('不算退回：领、续、做完（done）、记没做成（failed）、单关了收成 done / closed；从没退回过回 null', async () => {
    const repo = await addRepo(t.db, 'app');
    const task = await addTask(t.db, repo.id, { issueNumber: 1, state: 'failed' });
    expect(await lastLocalReturnAt(t.db, task.id)).toBeNull();
    await claimAt(1, NOW);
    await claimAt(1, later(HOUR)); // 续租
    expect(await lastLocalReturnAt(t.db, task.id)).toBeNull();
    await finishLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 1,
      outcome: 'failed',
      reason: '测不过',
      nodeId: NODE,
      now: later(2 * HOUR),
    });
    expect(await lastLocalReturnAt(t.db, task.id)).toBeNull();
    await claimAt(1, later(3 * HOUR));
    await settleExpiredLocalClaim(t.db, {
      taskId: task.id,
      how: 'closed',
      why: '单关了',
      now: later(LOCAL_LEASE_MS + 4 * HOUR),
    });
    expect(await lastLocalReturnAt(t.db, task.id)).toBeNull();
  });

  it('别的任务的退回不串', async () => {
    const repo = await addRepo(t.db, 'app');
    const a = await addTask(t.db, repo.id, { issueNumber: 1, state: 'failed' });
    const b = await addTask(t.db, repo.id, { issueNumber: 2, state: 'failed' });
    await claimAt(1, NOW);
    await finishLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 1,
      outcome: 'released',
      nodeId: NODE,
      now: later(HOUR),
    });
    expect(await lastLocalReturnAt(t.db, a.id)).not.toBeNull();
    expect(await lastLocalReturnAt(t.db, b.id)).toBeNull();
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

  it('listLocalClaims（GET 读口）：所有仓里本机领着、租约没到期的行，只给仓、单号、claimedBy、leaseUntil；到期的、引擎的、领完又结束的不在', async () => {
    await addRepo(t.db, 'app');
    const other = await addRepo(t.db, 'web');
    await claimLocalTask(t.db, { repo: 'acme/app', issueNumber: 5, title: 'x', nodeId: NODE, now: NOW });
    await claimLocalTask(t.db, { repo: 'acme/web', issueNumber: 2, title: 'y', nodeId: 'wsl-2', now: NOW });
    await claimLocalTask(t.db, { repo: 'acme/web', issueNumber: 3, title: 'z', nodeId: NODE, now: NOW });
    await finishLocalTask(t.db, {
      repo: 'acme/web',
      issueNumber: 3,
      outcome: 'done',
      nodeId: NODE,
      now: NOW,
    });
    await addTask(t.db, other.id, { issueNumber: 4, state: 'running', createdAt: NOW }); // 引擎的行
    const list = await listLocalClaims(t.db, NOW);
    expect(list).toEqual([
      { repo: 'acme/app', issue: 5, claimedBy: NODE, leaseUntil: new Date(NOW.getTime() + LOCAL_LEASE_MS) },
      {
        repo: 'acme/web',
        issue: 2,
        claimedBy: 'wsl-2',
        leaseUntil: new Date(NOW.getTime() + LOCAL_LEASE_MS),
      },
    ]);
    for (const r of list) expect(Object.keys(r).sort()).toEqual(['claimedBy', 'issue', 'leaseUntil', 'repo']);
    // 租约到点就不算了
    expect(await listLocalClaims(t.db, new Date(NOW.getTime() + LOCAL_LEASE_MS))).toEqual([]);
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
