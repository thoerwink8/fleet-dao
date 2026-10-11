// 「单已关且停下等人」真装配（#1816）：放弃信号走假口子，撤提醒走 resolveClosedIssueParkAlerts
// （真库 + resolveAlertWithReason），断言发信号、撤提醒、操作记录三件事都发生。
import { alertByKey, auditLog, notifications, repos, tasks, upsertAlert } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  abandonClosedIssueTasks,
  CLOSED_ISSUE_ABANDON_BY,
  CLOSED_ISSUE_ABANDON_REASON,
  type ClosedIssueTaskDeps,
} from '../../src/jobs/closed-issue-tasks.ts';
import { resolveClosedIssueParkAlerts } from '../../src/real/hourly-reconcile.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const NOW = new Date('2026-10-11T04:00:00.000Z');
const WF = 'task:acme/widgets#1795';
const PARK_KEY = `${WF}:park:1`;

async function seedParkAlert() {
  const [repo] = await t.db
    .insert(repos)
    .values({ owner: 'acme', name: 'widgets', testCommand: 'pnpm check' })
    .returning();
  if (!repo) throw new Error('repo 没写进去');
  const [task] = await t.db
    .insert(tasks)
    .values({
      repoId: repo.id,
      issueNumber: 1795,
      title: '演示',
      rawRequest: '演示',
      requestedBy: 'founder-a',
      priority: 10,
      state: 'stalled',
    })
    .returning();
  if (!task) throw new Error('task 没写进去');
  const { id } = await upsertAlert(t.db, {
    dedupeKey: PARK_KEY,
    level: 'alert',
    taskId: task.id,
    title: '#1795 动手 3 轮都没过',
    body: '停下等人：动手 3 轮都没过',
  });
  return { task, alertId: id };
}

function port(
  over: Partial<ClosedIssueTaskDeps['closedIssueTasks']> & {
    parked?: boolean;
    state?: 'open' | 'closed' | 'throw';
  } = {},
): {
  deps: ClosedIssueTaskDeps;
  signals: { workflowId: string; by: string; reason: string }[];
} {
  const signals: { workflowId: string; by: string; reason: string }[] = [];
  const { parked = true, state = 'closed', ...rest } = over;
  const deps: ClosedIssueTaskDeps = {
    closedIssueTasks: {
      runningTaskWorkflowIds: async () => [WF],
      isParked: async () => parked,
      resolveParkAlerts: (workflowId, why) =>
        resolveClosedIssueParkAlerts(t.db, workflowId, why, {
          by: CLOSED_ISSUE_ABANDON_BY,
          at: NOW,
        }),
      issueState: async () => {
        if (state === 'throw') throw new Error('GitHub 502');
        return state;
      },
      async abandon(workflowId, c) {
        signals.push({ workflowId, ...c });
        return 'sent';
      },
      ...rest,
    },
    now: () => NOW,
    log: () => {},
  };
  return { deps, signals };
}

describe('单已关且停下等人：真撤提醒并写操作记录（#1816）', () => {
  it('发放弃信号、撤挂起提醒、操作记录 reason 写「单已关，自动放弃」三件事都发生', async () => {
    const { alertId } = await seedParkAlert();
    const w = port();

    const part = await abandonClosedIssueTasks(w.deps);

    expect(w.signals).toEqual([
      {
        workflowId: WF,
        by: CLOSED_ISSUE_ABANDON_BY,
        reason: CLOSED_ISSUE_ABANDON_REASON,
      },
    ]);
    const row = await alertByKey(t.db, PARK_KEY);
    expect(row).toMatchObject({
      resolvedBy: CLOSED_ISSUE_ABANDON_BY,
      resolvedAt: NOW,
    });
    expect(row?.body).toMatch(/^已撤：单已关，自动放弃/);
    const audits = await t.db.select().from(auditLog);
    expect(audits).toEqual([
      expect.objectContaining({
        actorKind: 'engine',
        actorId: CLOSED_ISSUE_ABANDON_BY,
        action: 'notification.resolve',
        target: `notification:${alertId}`,
        reason: CLOSED_ISSUE_ABANDON_REASON,
        via: 'engine',
        ok: true,
      }),
    ]);
    expect(CLOSED_ISSUE_ABANDON_REASON).toBe('单已关，自动放弃');
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
  });

  it('单已关但任务还在跑（不是停下等人）：不发放弃、不撤提醒、不写操作记录', async () => {
    await seedParkAlert();
    const w = port({ parked: false });

    const part = await abandonClosedIssueTasks(w.deps);

    expect(w.signals).toEqual([]);
    expect((await alertByKey(t.db, PARK_KEY))?.resolvedAt).toBeNull();
    expect(await t.db.select().from(auditLog)).toEqual([]);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
  });

  it('读单状态失败：不放弃、不撤提醒、不写操作记录（不当成已关）', async () => {
    await seedParkAlert();
    const w = port({ state: 'throw' });

    const part = await abandonClosedIssueTasks(w.deps);

    expect(w.signals).toEqual([]);
    expect((await alertByKey(t.db, PARK_KEY))?.resolvedAt).toBeNull();
    expect(await t.db.select().from(auditLog)).toEqual([]);
    expect(part.found).toBe(0);
    expect(part.unchecked[0]).toContain('GitHub 502');
  });

  it('resolveClosedIssueParkAlerts：没有开着的挂起提醒时回 0、不写操作记录', async () => {
    expect(await resolveClosedIssueParkAlerts(t.db, WF, CLOSED_ISSUE_ABANDON_REASON, { at: NOW })).toBe(0);
    expect(await t.db.select().from(notifications)).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });
});
