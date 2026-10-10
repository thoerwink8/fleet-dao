// 单已关且停下等人就发放弃信号、撤挂起提醒（jobs/closed-issue-tasks.ts，#1198 / #1816）：
// 停下等人的发、还在跑的不动、读不到的记没查成不动、已结束的（收信人不在）不算问题。
// 读不到、发不成、撤提醒不成都故意造一次：不许记成 ok、不许拿「没读到」当「已关」。
// 操作记录真写入（resolveAlertWithReason → auditLog）见 test/real/closed-issue-tasks.test.ts。
import type { OpenTaskRow } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  abandonClosedIssueTasks,
  CLOSED_ISSUE_ABANDON_BY,
  CLOSED_ISSUE_ABANDON_REASON,
  type ClosedIssueTaskDeps,
  NEVER_DISPATCHED_STOP_REASON,
  parseTaskWorkflowId,
  settleIdleClosedIssueRows,
} from '../src/jobs/closed-issue-tasks.ts';

interface World {
  deps: ClosedIssueTaskDeps;
  signals: { workflowId: string; by: string; reason: string }[];
  resolved: { workflowId: string; why: string }[];
  stopped: { taskIds: string[]; reason: string }[];
  logs: string[];
}

function world(
  over: Partial<ClosedIssueTaskDeps['closedIssueTasks']> & {
    states?: Record<string, 'open' | 'closed'>;
    parked?: Record<string, boolean>;
    openRows?: OpenTaskRow[];
  } = {},
): World {
  const signals: World['signals'] = [];
  const resolved: World['resolved'] = [];
  const stopped: World['stopped'] = [];
  const logs: string[] = [];
  const { states = {}, parked = {}, openRows = [], openIssueLabels, ...port } = over;
  const deps: ClosedIssueTaskDeps = {
    closedIssueTasks: {
      runningTaskWorkflowIds: async () => [],
      openTaskRows: async () => openRows,
      async isParked(workflowId) {
        const hit = parked[workflowId];
        if (hit !== undefined) return hit;
        // 没写明就当停下等人：旧用例默认覆盖「要撤」那一支。
        return true;
      },
      async resolveParkAlerts(workflowId, why) {
        resolved.push({ workflowId, why });
        return 1;
      },
      async issueState(repo, n) {
        const s = states[`${repo.owner}/${repo.name}#${n}`];
        if (!s) throw new Error(`用例没给 ${repo.owner}/${repo.name}#${n} 的状态`);
        return s;
      },
      async stopRows(taskIds, reason) {
        stopped.push({ taskIds: [...taskIds], reason });
        return taskIds.length;
      },
      async abandon(workflowId, c) {
        signals.push({ workflowId, ...c });
        return 'sent';
      },
      // 标签读取口子显式转交：没给就不装配（对应「不提供就不收母单、本机做的排队行」）。
      ...(openIssueLabels && { openIssueLabels }),
      ...port,
    },
    now: () => new Date('2026-10-07T10:00:00.000Z'),
    log: (_level, text) => logs.push(text),
  };
  return { deps, signals, resolved, stopped, logs };
}

describe('parseTaskWorkflowId', () => {
  it('认得 task:<owner>/<repo>#<号>，认不出回 null', () => {
    expect(parseTaskWorkflowId('task:acme/demo#12')).toEqual({
      repo: { owner: 'acme', name: 'demo' },
      issueNumber: 12,
      generation: 1,
    });
    expect(parseTaskWorkflowId('task:acme/demo#12:r2')).toEqual({
      repo: { owner: 'acme', name: 'demo' },
      issueNumber: 12,
      generation: 2,
    });
    expect(parseTaskWorkflowId('task:acme/demo#12:park:1')).toBeNull();
    expect(parseTaskWorkflowId('req:acme/demo#12')).toBeNull();
    expect(parseTaskWorkflowId('task:acme/demo')).toBeNull();
  });
});

describe('单已关且停下等人就撤掉（abandonClosedIssueTasks，#1816）', () => {
  it('单已关、停下等人：发放弃信号、撤挂起提醒、reason/why 都写「单已关，自动放弃」；单开着的不动', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1', 'task:acme/demo#2'],
      parked: { 'task:acme/demo#1': true, 'task:acme/demo#2': true },
      states: { 'acme/demo#1': 'closed', 'acme/demo#2': 'open' },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([
      {
        workflowId: 'task:acme/demo#1',
        by: CLOSED_ISSUE_ABANDON_BY,
        reason: CLOSED_ISSUE_ABANDON_REASON,
      },
    ]);
    expect(w.resolved).toEqual([{ workflowId: 'task:acme/demo#1', why: CLOSED_ISSUE_ABANDON_REASON }]);
    expect(CLOSED_ISSUE_ABANDON_REASON).toBe('单已关，自动放弃');
    expect(part).toEqual({ scanned: 2, found: 1, unchecked: [] });
  });

  it('单已关但任务还在跑（不是停下等人）：不发放弃、不撤提醒', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1'],
      parked: { 'task:acme/demo#1': false },
      states: { 'acme/demo#1': 'closed' },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([]);
    expect(w.resolved).toEqual([]);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
  });

  it('读不到单的状态：记没查成，不发信号、不撤提醒（不当成开着也不当成已关）', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1'],
      parked: { 'task:acme/demo#1': true },
      issueState: async () => {
        throw new Error('GitHub 502');
      },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([]);
    expect(w.resolved).toEqual([]);
    expect(part.found).toBe(0);
    expect(part.unchecked).toHaveLength(1);
    expect(part.unchecked[0]).toContain('GitHub 502');
  });

  it('重做后的编号（:r2）也认得出是哪张单，关了且停下照样撤', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#4:r2'],
      parked: { 'task:acme/demo#4:r2': true },
      states: { 'acme/demo#4': 'closed' },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([
      {
        workflowId: 'task:acme/demo#4:r2',
        by: CLOSED_ISSUE_ABANDON_BY,
        reason: CLOSED_ISSUE_ABANDON_REASON,
      },
    ]);
    expect(w.resolved).toEqual([{ workflowId: 'task:acme/demo#4:r2', why: CLOSED_ISSUE_ABANDON_REASON }]);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
  });

  it('任务已经结束（收信人不在）：不动、不算问题、不撤提醒', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1'],
      parked: { 'task:acme/demo#1': true },
      states: { 'acme/demo#1': 'closed' },
      abandon: async () => 'gone',
    });
    expect(await abandonClosedIssueTasks(w.deps)).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(w.resolved).toEqual([]);
  });

  it('列不出在跑的任务：整部分 failed，不当成「没有」', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => {
        throw new Error('Temporal 连不上');
      },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(part.failed).toContain('Temporal 连不上');
    expect(part.scanned).toBe(0);
  });

  it('停没停着查不成：记没查成，不发信号', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1'],
      states: { 'acme/demo#1': 'closed' },
      isParked: async () => {
        throw new Error('查询超时');
      },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([]);
    expect(part.found).toBe(0);
    expect(part.unchecked[0]).toContain('查询超时');
  });

  it('信号发不成：记没查成；工作流编号认不出：记没查成，别的照常处理', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1', 'task:weird', 'task:acme/demo#3'],
      parked: {
        'task:acme/demo#1': true,
        'task:acme/demo#3': true,
      },
      states: { 'acme/demo#1': 'closed', 'acme/demo#3': 'closed' },
      async abandon(workflowId) {
        if (workflowId.endsWith('#1')) throw new Error('信号超时');
        return 'sent';
      },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(part.found).toBe(1);
    expect(part.unchecked).toHaveLength(2);
    expect(part.unchecked.join('；')).toContain('信号超时');
    expect(part.unchecked.join('；')).toContain('task:weird');
  });

  it('放弃成了、撤提醒没成：found 照加，记没查成', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1'],
      parked: { 'task:acme/demo#1': true },
      states: { 'acme/demo#1': 'closed' },
      resolveParkAlerts: async () => {
        throw new Error('库写失败');
      },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toHaveLength(1);
    expect(part.found).toBe(1);
    expect(part.unchecked[0]).toContain('库写失败');
  });
});

describe('单已关、没有工作流的遗留任务行（settleIdleClosedIssueRows）', () => {
  const row = (taskId = 'task-row-1', issueNumber = 1): OpenTaskRow => ({
    taskId,
    owner: 'acme',
    name: 'demo',
    issueNumber,
    state: 'running',
  });

  it('非终态行、没有工作流、单已关：改成 stopped，found 加一并记日志', async () => {
    const w = world({ openRows: [row()], states: { 'acme/demo#1': 'closed' } });

    const part = await settleIdleClosedIssueRows(w.deps);

    expect(w.stopped).toEqual([{ taskIds: ['task-row-1'], reason: '单已关闭，没有工作流在跑' }]);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(w.logs).toHaveLength(1);
  });

  it('工作流还在跑的行不查单、不改行', async () => {
    const w = world({
      openRows: [row()],
      runningTaskWorkflowIds: async () => ['task:acme/demo#1'],
    });

    const part = await settleIdleClosedIssueRows(w.deps);

    expect(w.stopped).toEqual([]);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
  });

  it('单还开着的行不动', async () => {
    const w = world({ openRows: [row()], states: { 'acme/demo#1': 'open' } });

    const part = await settleIdleClosedIssueRows(w.deps);

    expect(w.stopped).toEqual([]);
    expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
  });

  it('读单状态抛错：不改行，记进 unchecked', async () => {
    const w = world({
      openRows: [row()],
      issueState: async () => {
        throw new Error('GitHub 502');
      },
    });

    const part = await settleIdleClosedIssueRows(w.deps);

    expect(w.stopped).toEqual([]);
    expect(part).toMatchObject({ scanned: 1, found: 0 });
    expect(part.unchecked).toHaveLength(1);
    expect(part.unchecked[0]).toContain('GitHub 502');
  });

  it('列非终态任务行抛错：返回 failed，写明原因', async () => {
    const w = world({
      openTaskRows: async () => {
        throw new Error('数据库连不上');
      },
    });

    const part = await settleIdleClosedIssueRows(w.deps);

    expect(part.failed).toContain('数据库连不上');
    expect(part.found).toBe(0);
  });

  describe('单开着、但母单或本机做（引擎不派）', () => {
    const labelsOf = (labels: string[]) => async () => new Map<number, readonly string[]>([[1, labels]]);

    it('贴母单、没有工作流：stopRows，理由是新常量，found 加一', async () => {
      const w = world({
        openRows: [row()],
        states: { 'acme/demo#1': 'open' },
        openIssueLabels: labelsOf(['母单', '需求']),
      });

      const part = await settleIdleClosedIssueRows(w.deps);

      expect(w.stopped).toEqual([{ taskIds: ['task-row-1'], reason: NEVER_DISPATCHED_STOP_REASON }]);
      expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
    });

    it('贴本机做、没有工作流：同上', async () => {
      const w = world({
        openRows: [row()],
        states: { 'acme/demo#1': 'open' },
        openIssueLabels: labelsOf(['本机做']),
      });

      const part = await settleIdleClosedIssueRows(w.deps);

      expect(w.stopped).toEqual([{ taskIds: ['task-row-1'], reason: NEVER_DISPATCHED_STOP_REASON }]);
      expect(part.found).toBe(1);
    });

    it('只贴要人拍：不动', async () => {
      const w = world({
        openRows: [row()],
        states: { 'acme/demo#1': 'open' },
        openIssueLabels: labelsOf(['要人拍']),
      });

      const part = await settleIdleClosedIssueRows(w.deps);

      expect(w.stopped).toEqual([]);
      expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    });

    it('工作流还在跑的母单行：不动、不读标签', async () => {
      let reads = 0;
      const w = world({
        openRows: [row()],
        runningTaskWorkflowIds: async () => ['task:acme/demo#1'],
        openIssueLabels: async () => {
          reads += 1;
          return new Map([[1, ['母单']]]);
        },
      });

      const part = await settleIdleClosedIssueRows(w.deps);

      expect(w.stopped).toEqual([]);
      expect(reads).toBe(0);
      expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    });

    it('读标签抛错：这个仓的行都不改，unchecked 写明，不当成没贴标签', async () => {
      const w = world({
        openRows: [row('task-row-1', 1), row('task-row-2', 2)],
        states: { 'acme/demo#1': 'open', 'acme/demo#2': 'open' },
        openIssueLabels: async () => {
          throw new Error('GitHub 502');
        },
      });

      const part = await settleIdleClosedIssueRows(w.deps);

      expect(w.stopped).toEqual([]);
      expect(part).toMatchObject({ scanned: 2, found: 0 });
      expect(part.unchecked).toHaveLength(2);
      expect(part.unchecked[0]).toContain('GitHub 502');
    });

    it('world 把 openIssueLabels 原样转交给装配；不给就没有这个口子', () => {
      const read = async () => new Map<number, readonly string[]>();
      expect(world({ openIssueLabels: read }).deps.closedIssueTasks.openIssueLabels).toBe(read);
      expect(world().deps.closedIssueTasks.openIssueLabels).toBeUndefined();
    });

    it('没有标签口子：开着的单一律不动', async () => {
      const w = world({ openRows: [row()], states: { 'acme/demo#1': 'open' } });

      const part = await settleIdleClosedIssueRows(w.deps);

      expect(w.stopped).toEqual([]);
      expect(part).toEqual({ scanned: 1, found: 0, unchecked: [] });
    });

    it('同一个仓只读一次标签', async () => {
      let reads = 0;
      const w = world({
        openRows: [row('task-row-1', 1), row('task-row-2', 2)],
        states: { 'acme/demo#1': 'open', 'acme/demo#2': 'open' },
        openIssueLabels: async () => {
          reads += 1;
          return new Map([
            [1, ['母单']],
            [2, ['本机做']],
          ]);
        },
      });

      const part = await settleIdleClosedIssueRows(w.deps);

      expect(reads).toBe(1);
      expect(part.found).toBe(2);
    });
  });
});
