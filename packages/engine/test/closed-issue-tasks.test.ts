// 单已关、任务还挂着就发放弃信号（jobs/closed-issue-tasks.ts，#1198）：关了的发、开着的不动、读不到的记没查成不动、
// 已结束的（收信人不在）不算问题。读不到、发不成都故意造一次：不许记成 ok、不许撤任务。
import type { OpenTaskRow } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  abandonClosedIssueTasks,
  CLOSED_ISSUE_ABANDON_BY,
  CLOSED_ISSUE_ABANDON_REASON,
  type ClosedIssueTaskDeps,
  parseTaskWorkflowId,
  settleIdleClosedIssueRows,
} from '../src/jobs/closed-issue-tasks.ts';

interface World {
  deps: ClosedIssueTaskDeps;
  signals: { workflowId: string; by: string; reason: string }[];
  stopped: { taskIds: string[]; reason: string }[];
  logs: string[];
}

function world(
  over: Partial<ClosedIssueTaskDeps['closedIssueTasks']> & {
    states?: Record<string, 'open' | 'closed'>;
    openRows?: OpenTaskRow[];
  } = {},
): World {
  const signals: World['signals'] = [];
  const stopped: World['stopped'] = [];
  const logs: string[] = [];
  const { states = {}, openRows = [], ...port } = over;
  const deps: ClosedIssueTaskDeps = {
    closedIssueTasks: {
      runningTaskWorkflowIds: async () => [],
      openTaskRows: async () => openRows,
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
      ...port,
    },
    now: () => new Date('2026-10-07T10:00:00.000Z'),
    log: (_level, text) => logs.push(text),
  };
  return { deps, signals, stopped, logs };
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

describe('单已关就撤掉还挂着的任务（abandonClosedIssueTasks）', () => {
  it('单已关、任务还在：发放弃信号，by、reason 都写；单开着的不动', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1', 'task:acme/demo#2'],
      states: { 'acme/demo#1': 'closed', 'acme/demo#2': 'open' },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([
      { workflowId: 'task:acme/demo#1', by: CLOSED_ISSUE_ABANDON_BY, reason: CLOSED_ISSUE_ABANDON_REASON },
    ]);
    expect(CLOSED_ISSUE_ABANDON_REASON).toBe('单已关闭');
    expect(part).toEqual({ scanned: 2, found: 1, unchecked: [] });
  });

  it('重做后的编号（:r2）也认得出是哪张单，关了照样撤', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#4:r2'],
      states: { 'acme/demo#4': 'closed' },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([
      { workflowId: 'task:acme/demo#4:r2', by: CLOSED_ISSUE_ABANDON_BY, reason: CLOSED_ISSUE_ABANDON_REASON },
    ]);
    expect(part).toEqual({ scanned: 1, found: 1, unchecked: [] });
  });

  it('读不到单的状态：记没查成，不发信号（不当成开着也不当成已关）', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1'],
      issueState: async () => {
        throw new Error('GitHub 502');
      },
    });
    const part = await abandonClosedIssueTasks(w.deps);
    expect(w.signals).toEqual([]);
    expect(part.found).toBe(0);
    expect(part.unchecked).toHaveLength(1);
    expect(part.unchecked[0]).toContain('GitHub 502');
  });

  it('任务已经结束（收信人不在）：不动、不算问题', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1'],
      states: { 'acme/demo#1': 'closed' },
      abandon: async () => 'gone',
    });
    expect(await abandonClosedIssueTasks(w.deps)).toEqual({ scanned: 1, found: 0, unchecked: [] });
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

  it('信号发不成：记没查成；工作流编号认不出：记没查成，别的照常处理', async () => {
    const w = world({
      runningTaskWorkflowIds: async () => ['task:acme/demo#1', 'task:weird', 'task:acme/demo#3'],
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
});
