// 每小时对账卡在某个子步骤时，最后一条日志要能对上还在等哪一步（同一 runId、稳定步骤名、开始/结束/失败、耗时）。
// 修前没有当前步骤：下面「未返回」那条对不上 worktrees 的开始，会红。不另起探针，也不把这一轮记成已经跑完。
import type { ScheduleResult } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  HOURLY_RECONCILE_OPTIONAL_STEPS,
  HOURLY_RECONCILE_STEPS,
  type HourlyReconcileJobDeps,
  type HourlyReconcileStep,
  runHourlyReconcileJob,
} from '../../src/jobs/hourly-reconcile.ts';

const RUN = 4401;
const ROOT = '/var/lib/fleet-work';
const OPTIONAL = new Set<string>(HOURLY_RECONCILE_OPTIONAL_STEPS);

interface LogRow {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

interface Harness {
  deps: HourlyReconcileJobDeps;
  finished: { id: number; result: ScheduleResult }[];
  logs: LogRow[];
}

function fakeClock(iso = '2026-10-21T03:02:00.000Z') {
  let t = Date.parse(iso);
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

function probeDirs(onRoot?: () => void): HourlyReconcileJobDeps['listDir'] {
  return async (dir) => {
    if (dir === ROOT) {
      onRoot?.();
      return [{ name: '_route-probe', isDir: true }];
    }
    if (dir === `${ROOT}/_route-probe`) return [{ name: 'fleet-agent-carpool', isDir: true }];
    throw new Error(`用例没给 ${dir}`);
  };
}

function harness(over: Partial<HourlyReconcileJobDeps> = {}): Harness {
  const finished: Harness['finished'] = [];
  const logs: LogRow[] = [];
  const deps: HourlyReconcileJobDeps = {
    root: ROOT,
    probeDir: '_route-probe',
    sessionTmpDir: '_tmp',
    machine: '法国',
    listDir: probeDirs(),
    treeFor: (repo, branch) => `${ROOT}/${repo.owner}_${repo.name}/${branch.replace(/^fleet\//, '')}`,
    ownerOf: async () => null,
    leftovers: async () => ({ kind: 'empty' }),
    remove: async () => ({ gone: true }),
    keepShots: async () => ({ outcome: 'none', head: '', branch: 'shots/0', files: [] }),
    issue: async () => null,
    prHeads: async () => [],
    subtaskTrees: async () => [],
    openSessions: async () => [],
    workflows: {
      state: async () => ({ state: 'missing' }),
      view: async () => {
        throw new Error('不该问');
      },
    },
    taskState: async () => null,
    approval: async () => null,
    stageRoutable: async () => ({ kind: 'none', detail: '没有在线的路由' }),
    alerts: {
      listOpen: async () => ({ alerts: [], truncated: false }),
      byKey: async () => null,
      latestByPrefix: async () => null,
      resolve: async () => 'not_found',
      raise: async () => {},
      insertOnce: async () => ({ created: true }),
      updateOpen: async () => 'not_open',
    },
    repos: async () => [],
    auditMergedPrs: async () => ({
      outcome: 'ok',
      scanned: 0,
      found: 0,
      fixed: 0,
      problems: [],
      findings: [],
    }),
    ledgers: async () => [],
    apps: { repos: async () => [], selfCheck: async () => [] },
    gh: {
      listPrs: async () => [],
      pullFiles: async () => [],
      checksEvaluate: async () => 'none',
      requiredChecks: async () => ['check'],
      readStandardPathsFile: async () => '{"paths":[]}',
      enableAutoMerge: async () => {},
    },
    autoMergeAlerts: {
      raise: async () => {},
      resolve: async () => 'not_found',
      listOpenByPrefix: async () => [],
    },
    closedIssueTasks: {
      runningTaskWorkflowIds: async () => [],
      isParked: async () => false,
      resolveParkAlerts: async () => 0,
      issueState: async () => 'open',
      abandon: async () => 'gone',
    },
    runs: {
      async start() {
        return RUN;
      },
      async finish(id, result) {
        finished.push({ id, result });
      },
    },
    now: () => new Date('2026-10-21T03:02:00.000Z'),
    log: (level, message, fields) => {
      logs.push({ level, message, fields: { ...(fields ?? {}) } });
    },
    ...over,
  };
  return { deps, finished, logs };
}

function stepRows(logs: LogRow[]): LogRow[] {
  return logs.filter((row) => typeof row.fields.step === 'string');
}

function view(row: LogRow): { runId: unknown; step: unknown; phase: unknown; ms?: unknown } {
  const base = { runId: row.fields.runId, step: row.fields.step, phase: row.fields.phase };
  return row.fields.ms === undefined ? base : { ...base, ms: row.fields.ms };
}

const WORD = { start: '开始', end: '结束', failed: '失败', skip: '缺省跳过' } as const;

function assertStepEvidence(logs: LogRow[]): void {
  for (const row of stepRows(logs)) {
    const phase = row.fields.phase;
    expect(phase === 'start' || phase === 'end' || phase === 'failed' || phase === 'skip').toBe(true);
    const keys = Object.keys(row.fields).sort();
    expect(keys).toEqual(
      phase === 'start' || phase === 'skip' ? ['phase', 'runId', 'step'] : ['ms', 'phase', 'runId', 'step'],
    );
    expect(row.fields.runId).toBe(RUN);
    const word = WORD[phase as keyof typeof WORD];
    expect(row.message).toBe(`每小时对账：子步骤 ${String(row.fields.step)} ${word}`);
    expect(row.level).toBe(phase === 'failed' ? 'error' : 'info');
    if (phase === 'failed') expect(row.message).not.toContain('结束');
  }
}

function successTrace(ms: Partial<Record<HourlyReconcileStep, number>>) {
  const out: { runId: number; step: HourlyReconcileStep; phase: string; ms?: number }[] = [];
  for (const step of HOURLY_RECONCILE_STEPS) {
    if (OPTIONAL.has(step)) {
      out.push({ runId: RUN, step, phase: 'skip' });
      continue;
    }
    out.push({ runId: RUN, step, phase: 'start' });
    out.push({ runId: RUN, step, phase: 'end', ms: ms[step] ?? 0 });
  }
  return out;
}

describe('每小时对账子步骤在途证据', () => {
  it('子步骤未返回：最后一条是当前步骤开始，没有结束，后续步骤还没执行', async () => {
    let release: (rows: { name: string; isDir: boolean }[]) => void = () => {};
    const gate = new Promise<{ name: string; isDir: boolean }[]>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const enteredWorktrees = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const calls = { open: 0, audit: 0, ledgers: 0, appRepos: 0 };
    const h = harness({
      listDir: async (dir) => {
        if (dir === ROOT) {
          entered();
          return gate;
        }
        if (dir === `${ROOT}/_route-probe`) return [{ name: 'fleet-agent-carpool', isDir: true }];
        throw new Error(`用例没给 ${dir}`);
      },
      repos: async () => [{ owner: 'acme', name: 'widgets' }],
      auditMergedPrs: async () => {
        calls.audit += 1;
        return { outcome: 'ok', scanned: 0, found: 0, fixed: 0, problems: [], findings: [] };
      },
      ledgers: async () => {
        calls.ledgers += 1;
        return [];
      },
      apps: {
        repos: async () => {
          calls.appRepos += 1;
          return [];
        },
        selfCheck: async () => [],
      },
      alerts: {
        listOpen: async () => {
          calls.open += 1;
          return { alerts: [], truncated: false };
        },
        byKey: async () => null,
        latestByPrefix: async () => null,
        resolve: async () => 'not_found',
        raise: async () => {},
        insertOnce: async () => ({ created: true }),
        updateOpen: async () => 'not_open',
      },
    });
    const pending = runHourlyReconcileJob(h.deps);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = await Promise.race([
        enteredWorktrees.then(() => 'entered' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), 1000);
        }),
      ]);
      expect(started).toBe('entered');
      assertStepEvidence(h.logs);
      expect(stepRows(h.logs).map(view)).toEqual([
        { runId: RUN, step: 'alerts-before-worktrees', phase: 'start' },
        { runId: RUN, step: 'alerts-before-worktrees', phase: 'end', ms: 0 },
        { runId: RUN, step: 'worktrees', phase: 'start' },
      ]);
      expect(h.logs.at(-1)?.message).toBe('每小时对账：子步骤 worktrees 开始');
      expect(h.finished).toEqual([]);
      expect(calls).toEqual({ open: 1, audit: 0, ledgers: 0, appRepos: 0 });
    } finally {
      if (timer) clearTimeout(timer);
      release([{ name: '_route-probe', isDir: true }]);
      await pending;
    }
    expect(calls.audit).toBe(1);
    expect(calls.ledgers).toBe(1);
    expect(calls.appRepos).toBe(2);
    const worktrees = stepRows(h.logs)
      .filter((row) => row.fields.step === 'worktrees')
      .map(view);
    expect(worktrees[0]).toEqual({ runId: RUN, step: 'worktrees', phase: 'start' });
    expect(worktrees[1]).toEqual({ runId: RUN, step: 'worktrees', phase: 'end', ms: 0 });
    expect(worktrees.some((row) => row.phase === 'failed')).toBe(false);
  });

  it('假时钟：成功时按顺序开始并结束，可选步骤缺省只记跳过，耗时确定，同一 runId', async () => {
    const clock = fakeClock();
    let rooted = false;
    const h = harness({
      now: clock.now,
      listDir: probeDirs(() => {
        if (!rooted) {
          rooted = true;
          clock.advance(25);
        }
      }),
      ledgers: async () => {
        clock.advance(80);
        return [];
      },
      closedIssueTasks: {
        runningTaskWorkflowIds: async () => {
          clock.advance(40);
          return [];
        },
        isParked: async () => false,
        resolveParkAlerts: async () => 0,
        issueState: async () => 'open',
        abandon: async () => 'gone',
      },
    });
    const run = await runHourlyReconcileJob(h.deps);
    assertStepEvidence(h.logs);
    expect(stepRows(h.logs).map(view)).toEqual(
      successTrace({ worktrees: 25, ledgers: 80, 'closed-issue-tasks': 40 }),
    );
    expect(run).toEqual({ runId: RUN, outcome: 'ok', scanned: 1, found: 0 });
    expect(h.finished).toEqual([{ id: RUN, result: { outcome: 'ok', scanned: 1, found: 0 } }]);
    expect(h.logs.at(-1)?.message).toBe('每小时对账跑完了');
  });

  it('接上的可选步骤按时钟记开始和结束，没接上的仍只记跳过', async () => {
    const clock = fakeClock();
    const h = harness({
      now: clock.now,
      pendingCleanup: async () => {
        clock.advance(5);
        return [];
      },
      saveInventory: async () => {
        clock.advance(9);
      },
    });
    const run = await runHourlyReconcileJob(h.deps);
    assertStepEvidence(h.logs);
    const rows = stepRows(h.logs).map(view);
    expect(rows.filter((row) => row.step === 'pending-cleanup')).toEqual([
      { runId: RUN, step: 'pending-cleanup', phase: 'start' },
      { runId: RUN, step: 'pending-cleanup', phase: 'end', ms: 5 },
    ]);
    expect(rows.filter((row) => row.step === 'save-inventory')).toEqual([
      { runId: RUN, step: 'save-inventory', phase: 'start' },
      { runId: RUN, step: 'save-inventory', phase: 'end', ms: 9 },
    ]);
    expect(rows.filter((row) => row.step === 'pool-hold-push')).toEqual([
      { runId: RUN, step: 'pool-hold-push', phase: 'skip' },
    ]);
    expect(rows.filter((row) => row.step === 'main-red-push')).toEqual([
      { runId: RUN, step: 'main-red-push', phase: 'skip' },
    ]);
    expect(run).toEqual({ runId: RUN, outcome: 'ok', scanned: 1, found: 0 });
  });

  it('可选步骤返回没查成：记结束和耗时，这一轮仍是 partial，不记 ok', async () => {
    const clock = fakeClock();
    const h = harness({
      now: clock.now,
      poolHoldPush: async () => {
        clock.advance(12);
        return { scanned: 1, found: 0, unchecked: ['整池暂停到期，飞书没推成：推送没配，交不出去'] };
      },
    });
    const run = await runHourlyReconcileJob(h.deps);
    assertStepEvidence(h.logs);
    expect(
      stepRows(h.logs)
        .filter((row) => row.fields.step === 'pool-hold-push')
        .map(view),
    ).toEqual([
      { runId: RUN, step: 'pool-hold-push', phase: 'start' },
      { runId: RUN, step: 'pool-hold-push', phase: 'end', ms: 12 },
    ]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('飞书没推成');
    expect(h.finished[0]?.result.outcome).toBe('partial');
  });

  it('拒绝和返回的失败都记失败、不记结束或 ok；partial / failed 判法不变', async () => {
    const rejected = fakeClock();
    const rejectedHarness = harness({
      now: rejected.now,
      poolHoldPush: async () => {
        rejected.advance(33);
        throw new Error('推送炸了');
      },
    });
    const rejectedRun = await runHourlyReconcileJob(rejectedHarness.deps);
    assertStepEvidence(rejectedHarness.logs);
    const rejectedRows = stepRows(rejectedHarness.logs).map(view);
    expect(rejectedRows.filter((row) => row.step === 'pool-hold-push')).toEqual([
      { runId: RUN, step: 'pool-hold-push', phase: 'start' },
      { runId: RUN, step: 'pool-hold-push', phase: 'failed', ms: 33 },
    ]);
    const failedAt = rejectedRows.findIndex((row) => row.step === 'pool-hold-push' && row.phase === 'failed');
    const skippedAt = rejectedRows.findIndex((row) => row.step === 'main-red-push' && row.phase === 'skip');
    expect(skippedAt).toBeGreaterThan(failedAt);
    expect(rejectedRows.some((row) => row.step === 'pool-hold-push' && row.phase === 'end')).toBe(false);
    expect(
      rejectedHarness.logs.some(
        (row) => row.fields.step === 'pool-hold-push' && row.message.includes('推送炸了'),
      ),
    ).toBe(false);
    expect(rejectedRun.outcome).toBe('partial');
    expect(rejectedRun.why).toContain('整池暂停到期的飞书推送没跑成：推送炸了');
    expect(rejectedHarness.finished[0]?.result.outcome).toBe('partial');

    const returned = fakeClock();
    const returnedHarness = harness({
      now: returned.now,
      ledgers: async () => {
        returned.advance(80);
        throw new Error('关系 runs 不存在');
      },
    });
    const returnedRun = await runHourlyReconcileJob(returnedHarness.deps);
    assertStepEvidence(returnedHarness.logs);
    const returnedRows = stepRows(returnedHarness.logs).map(view);
    expect(returnedRows.filter((row) => row.step === 'ledgers')).toEqual([
      { runId: RUN, step: 'ledgers', phase: 'start' },
      { runId: RUN, step: 'ledgers', phase: 'failed', ms: 80 },
    ]);
    const ledgerAt = returnedRows.findIndex((row) => row.step === 'ledgers' && row.phase === 'failed');
    const appsAt = returnedRows.findIndex((row) => row.step === 'github-apps' && row.phase === 'end');
    expect(appsAt).toBeGreaterThan(ledgerAt);
    expect(
      returnedHarness.logs.some((row) => row.fields.step === 'ledgers' && row.message.includes('关系 runs')),
    ).toBe(false);
    expect(returnedRun.outcome).toBe('partial');
    expect(returnedRun.why).toContain('读合了的 PR 和会话记账没成：关系 runs 不存在');
    expect(returnedHarness.finished[0]?.result.outcome).toBe('partial');

    const crashed = fakeClock();
    const crashedHarness = harness({
      now: crashed.now,
      listDir: async () => {
        crashed.advance(17);
        throw new Error('EACCES: 故意造的');
      },
      alerts: {
        listOpen: async () => {
          throw new Error('库连不上');
        },
        byKey: async () => null,
        latestByPrefix: async () => null,
        resolve: async () => 'not_found',
        raise: async () => {},
        insertOnce: async () => ({ created: true }),
        updateOpen: async () => 'not_open',
      },
    });
    await expect(runHourlyReconcileJob(crashedHarness.deps)).rejects.toMatchObject({
      name: 'HourlyReconcileFailedError',
      runId: RUN,
      message: expect.stringContaining('EACCES'),
    });
    assertStepEvidence(crashedHarness.logs);
    expect(
      stepRows(crashedHarness.logs)
        .filter((row) => row.fields.step === 'worktrees')
        .map(view),
    ).toEqual([
      { runId: RUN, step: 'worktrees', phase: 'start' },
      { runId: RUN, step: 'worktrees', phase: 'failed', ms: 17 },
    ]);
    expect(crashedHarness.finished[0]?.result.outcome).toBe('failed');
    expect(crashedHarness.finished[0]?.result.why).toEqual(expect.stringContaining('库连不上'));
    expect(crashedHarness.logs.some((row) => row.message === '每小时对账跑完了')).toBe(false);
    expect(crashedHarness.logs.some((row) => row.message === '每小时对账这一轮没跑成')).toBe(true);
  });
});
