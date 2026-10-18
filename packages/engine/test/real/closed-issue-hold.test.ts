// 关单收尾的真口子（#3002）：taskStatus 认检查点软暂停之后才数开着的会话。
// 数不到、查询失败不发放弃；parked 不问会话数。Update 消费回执走假客户端，撤提醒走真库。
import { alertByKey, repos, runs, tasks, upsertAlert } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { type Client, WorkflowNotFoundError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  abandonClosedIssueTasks,
  CLOSED_ISSUE_ABANDON_BY,
  CLOSED_ISSUE_ABANDON_REASON,
  type ClosedIssueTaskDeps,
} from '../../src/jobs/closed-issue-tasks.ts';
import { temporalClosedIssueTasks } from '../../src/real/hourly-reconcile.ts';
import type { ClosedIssueHoldToken } from '../../src/task-contract.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const NOW = new Date('2026-10-18T00:00:00.000Z');
const WF = 'task:acme/widgets#2928';
const PARK = `${WF}:park:1`;
const TOKEN: ClosedIssueHoldToken = {
  version: 1,
  runId: '00000000-0000-4000-8000-000000000001',
  kind: 'paused',
  generation: 1,
  continued: 0,
};
const pausedStatus = {
  phase: 'paused',
  doing: '已暂停',
  waiting: { kind: 'paused', detail: '已暂停（等「继续」或「放弃」）', since: '2026-10-17T20:32:41.000Z' },
  closedIssueClose: { version: 1, token: TOKEN },
};

function clientFor(
  status: unknown,
  signal: (arg: unknown) => Promise<void> | void,
  updateResult: unknown = 'accepted',
): Pick<Client, 'workflow' | 'connection'> {
  return {
    workflow: {
      list: async function* () {
        yield { workflowId: WF };
      },
      getHandle: () => ({
        query: async () => {
          if (status instanceof Error) throw status;
          return status;
        },
        executeUpdate: async (_def: unknown, options: { args: [{ command: unknown }] }) => {
          await signal(options.args[0].command);
          return updateResult;
        },
      }),
    },
    connection: {
      withDeadline: async (_deadline: number, fn: () => Promise<unknown>) => fn(),
    },
  } as unknown as Pick<Client, 'workflow' | 'connection'>;
}

function wired(
  status: unknown,
  issue: 'open' | 'closed' | 'throw' = 'closed',
): { deps: ClosedIssueTaskDeps; signals: unknown[] } {
  const signals: unknown[] = [];
  const port = temporalClosedIssueTasks(
    clientFor(status, (arg) => {
      signals.push(arg);
    }),
    {
      readIssueState: async () => {
        if (issue === 'throw') throw new Error('GitHub 502');
        return { state: issue, stateReason: null };
      },
    },
    t.db,
    () => NOW,
  );
  return { deps: { closedIssueTasks: port, now: () => NOW, log: () => {} }, signals };
}

describe('temporalClosedIssueTasks.holdForClose（#3002）', () => {
  it('旧 worker 缺能力、能力版本或停法凭据坏了：明确未核实，绝不回退 signal', async () => {
    for (const closedIssueClose of [
      undefined,
      { version: 2, token: TOKEN },
      { version: 1, token: { ...TOKEN, generation: 0 } },
      { version: 1, token: { ...TOKEN, continued: -1 } },
      { version: 1, token: { ...TOKEN, runId: '' } },
      { version: 1, token: { ...TOKEN, kind: 'parked' } },
    ]) {
      const w = wired({ ...pausedStatus, closedIssueClose });
      const part = await abandonClosedIssueTasks(w.deps);
      expect(part.found).toBe(0);
      expect(part.unchecked).toHaveLength(1);
      expect(w.signals).toEqual([]);
    }
    const resumed = wired({ ...pausedStatus, closedIssueClose: { version: 1, token: null } });
    expect(await abandonClosedIssueTasks(resumed.deps)).toEqual({ scanned: 1, found: 0, unchecked: [] });
  });

  it('Update 只绑定凭据中的精确 run；相同停法重试使用相同 updateId，核真实消费结果', async () => {
    const calls: { workflowId: string; runId: string | undefined; options: unknown }[] = [];
    let result: unknown = 'stale';
    const client = {
      workflow: {
        getHandle: (workflowId: string, runId?: string) => ({
          executeUpdate: async (_definition: unknown, options: unknown) => {
            calls.push({ workflowId, runId, options });
            return result;
          },
        }),
      },
      connection: { withDeadline: async (_deadline: number, fn: () => Promise<unknown>) => fn() },
    } as unknown as Pick<Client, 'workflow' | 'connection'>;
    const port = temporalClosedIssueTasks(
      client,
      { readIssueState: async () => ({ state: 'closed', stateReason: null }) },
      t.db,
      () => NOW,
    );
    const command = { by: CLOSED_ISSUE_ABANDON_BY, reason: CLOSED_ISSUE_ABANDON_REASON };
    expect(await port.abandon(WF, command, TOKEN)).toBe('stale');
    result = 'accepted';
    expect(await port.abandon(WF, command, TOKEN)).toBe('accepted');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toEqual({
      workflowId: WF,
      runId: TOKEN.runId,
      options: {
        args: [{ token: TOKEN, command }],
        updateId: `closed-issue:${TOKEN.runId}:paused:1:0`,
      },
    });
    result = 'sent';
    await expect(port.abandon(WF, command, TOKEN)).rejects.toThrow('消费回执认不出');
    await expect(port.abandon(WF, command)).rejects.toThrow('缺少关单停法凭据');
  });

  it('Update RPC 超时结果未知或旧 worker 没有 handler：不虚记成功、不撤提醒', async () => {
    for (const message of [
      'WorkflowUpdateRPCTimeoutOrCancelledError: outcome unknown',
      'Unknown update name',
    ]) {
      const client = clientFor(
        {
          ...pausedStatus,
          phase: 'parked',
          waiting: { kind: 'human', detail: '等人', since: NOW.toISOString() },
          closedIssueClose: { version: 1, token: { ...TOKEN, kind: 'parked' } },
        },
        () => {
          throw Error(message);
        },
      );
      const port = temporalClosedIssueTasks(
        client,
        { readIssueState: async () => ({ state: 'closed', stateReason: null }) },
        t.db,
        () => NOW,
      );
      const part = await abandonClosedIssueTasks({ closedIssueTasks: port, now: () => NOW, log: () => {} });
      expect(part.found).toBe(0);
      expect(part.unchecked.join(' ')).toContain(message);
    }
  });
  it('parked 不问会话数（没有任务行也不抛），关了就发放弃', async () => {
    const w = wired({
      phase: 'parked',
      doing: '停下等人',
      waiting: { kind: 'human', detail: '等', since: '2026-10-17T20:00:00.000Z' },
      closedIssueClose: { version: 1, token: { ...TOKEN, kind: 'parked' } },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(w.signals).toEqual([{ by: CLOSED_ISSUE_ABANDON_BY, reason: CLOSED_ISSUE_ABANDON_REASON }]);
  });

  it('implement 不问会话数：没有任务行也不记没查成、不发放弃', async () => {
    const w = wired({ phase: 'implement', doing: '动手', waiting: null });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([]);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
  });

  it('检查点软暂停但没有任务行：记没查成，不拿空当没有会话，不发放弃', async () => {
    const w = wired(pausedStatus);
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([]);
    expect(part.found).toBe(0);
    expect(part.unchecked[0]).toContain('没有任务行');
  });

  it('检查点上还有开着的会话：不发放弃；只有已结束的会话才发，并撤挂起提醒', async () => {
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'acme', name: 'widgets', testCommand: 'pnpm check' })
      .returning();
    if (!repo) throw new Error('repo 没写进去');
    const [task] = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 2928,
        title: '演示',
        rawRequest: '演示',
        requestedBy: 'founder-a',
        priority: 10,
        state: 'running',
        executor: 'engine',
      })
      .returning();
    if (!task) throw new Error('task 没写进去');
    await upsertAlert(t.db, {
      dedupeKey: PARK,
      level: 'alert',
      taskId: task.id,
      title: '挂起',
      body: '停下等人',
    });
    await t.db.insert(runs).values({
      segment: 'manual',
      model: 'm1',
      taskId: task.id,
      workflowId: WF,
      startedAt: NOW,
    });
    const open = wired(pausedStatus);
    expect(await abandonClosedIssueTasks(open.deps)).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(open.signals).toEqual([]);
    expect((await alertByKey(t.db, PARK))?.resolvedAt).toBeNull();

    await t.db.update(runs).set({ endedAt: NOW, outcome: 'done' });
    const done = wired(pausedStatus);
    const part = await abandonClosedIssueTasks(done.deps);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(done.signals).toEqual([{ by: CLOSED_ISSUE_ABANDON_BY, reason: CLOSED_ISSUE_ABANDON_REASON }]);
    expect((await alertByKey(t.db, PARK))?.resolvedBy).toBe(CLOSED_ISSUE_ABANDON_BY);
    const [row] = await t.db.select().from(tasks);
    expect(row).toMatchObject({ state: 'running', lastProblem: null });
  });

  it('查询失败、或放弃时工作流已经没了：不发成功，不撤提醒', async () => {
    const missing = wired(new WorkflowNotFoundError('没有这条', WF, undefined));
    const missed = await abandonClosedIssueTasks(missing.deps);
    expect(missing.signals).toEqual([]);
    expect(missed.found).toBe(0);
    expect(missed.unchecked[0]).toContain('没有这条');

    const port = temporalClosedIssueTasks(
      clientFor(pausedStatus, () => {
        throw new Error('workflow execution already completed');
      }),
      { readIssueState: async () => ({ state: 'closed', stateReason: null }) },
      t.db,
      () => NOW,
    );
    // 先放一行任务，检查点这条才会去数会话；数完才发信号，信号里才看得到「已经结束」。
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'acme', name: 'widgets', testCommand: 'pnpm check' })
      .returning();
    if (!repo) throw new Error('repo 没写进去');
    await t.db.insert(tasks).values({
      repoId: repo.id,
      issueNumber: 2928,
      title: '演示',
      rawRequest: '演示',
      requestedBy: 'founder-a',
      priority: 10,
      state: 'running',
    });
    const part = await abandonClosedIssueTasks({
      closedIssueTasks: port,
      now: () => NOW,
      log: () => {},
    });
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
  });

  it('GitHub 状态读失败：不发放弃', async () => {
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'acme', name: 'widgets', testCommand: 'pnpm check' })
      .returning();
    if (!repo) throw new Error('repo 没写进去');
    await t.db.insert(tasks).values({
      repoId: repo.id,
      issueNumber: 2928,
      title: '演示',
      rawRequest: '演示',
      requestedBy: 'founder-a',
      priority: 10,
      state: 'running',
    });
    const w = wired(pausedStatus, 'throw');
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([]);
    expect(part.found).toBe(0);
    expect(part.unchecked[0]).toContain('GitHub 502');
  });
});
