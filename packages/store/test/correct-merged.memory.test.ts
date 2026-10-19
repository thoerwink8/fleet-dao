import { CORRECT_MERGED_AUDIT_ACTION } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/memory-store.ts';

const TASK = 'd629758a-570d-405d-be00-417b7ee6c0c7';
const WHEN = '2026-10-19T01:52:06.446Z';

function store() {
  return createMemoryStore(
    {
      repos: [
        {
          id: 'repo',
          owner: 'thoerwink8',
          name: 'fleet-dao',
          defaultBranch: 'main',
          testCommand: 'pnpm test',
        },
      ],
      tasks: [
        {
          id: TASK,
          repoId: 'repo',
          issueNumber: 3114,
          title: '合成',
          rawRequest: '合成',
          requestedBy: 'test',
          state: 'stopped',
          priority: 0,
          createdAt: WHEN,
          executor: 'engine',
        },
      ],
      taskClosures: [{ taskId: TASK, phase: 'abandoned', updatedAt: WHEN }],
      segmentRuns: [
        {
          id: 'run-row',
          segment: 'manual',
          taskId: TASK,
          model: 'test',
          startedAt: WHEN,
          endedAt: WHEN,
          outcome: 'done',
          workflowId: 'task:thoerwink8/fleet-dao#3114',
          prNumber: 3137,
        },
      ],
    },
    { now: () => new Date('2026-10-19T02:00:00.000Z') },
  );
}

const input = {
  taskId: TASK,
  expectedUpdatedAtMs: Date.parse(WHEN),
  workflowId: 'task:thoerwink8/fleet-dao#3114',
  runId: '01a14fd8-fb57-741a-8c14-42e3fdba87d6',
  prNumber: 3137,
  audit: {
    actorId: 'ops:correct-merged:founder',
    reason: '合成',
    before: { state: 'stopped', phase: 'abandoned' },
    after: { state: 'done', phase: 'merged' },
  },
};

describe('内存版受管纠正', () => {
  it('改任务行并写操作记录；审计写不进就回到原样', async () => {
    const memory = store();
    expect(await memory.casCorrectMerged(input)).toBe('corrected');
    expect(memory.data.tasks[0]?.state).toBe('done');
    expect(memory.data.taskClosures[0]?.phase).toBe('merged');
    expect(memory.data.audit.some((row) => row.action === CORRECT_MERGED_AUDIT_ACTION && row.ok)).toBe(true);
    expect(memory.data.stateChanges.some((row) => row.from === 'stopped' && row.to === 'done')).toBe(true);

    const again = store();
    again.data.audit.push = () => {
      throw new Error('audit boom');
    };
    await expect(again.casCorrectMerged(input)).rejects.toThrow('audit boom');
    expect(again.data.tasks[0]?.state).toBe('stopped');
    expect(again.data.taskClosures[0]?.phase).toBe('abandoned');
    expect(again.data.taskClosures[0]?.updatedAt).toBe(WHEN);
    expect(again.data.stateChanges.some((row) => row.to === 'done')).toBe(false);
  });

  it('同一工作流另有不同 PR 的会话就不写', async () => {
    const memory = store();
    memory.data.segmentRuns.push({
      id: 'other-pr',
      segment: 'manual',
      taskId: TASK,
      model: 'test',
      startedAt: WHEN,
      endedAt: WHEN,
      outcome: 'done',
      workflowId: 'task:thoerwink8/fleet-dao#3114',
      prNumber: 99999,
    });
    expect(await memory.casCorrectMerged(input)).toBe('stale');
    expect(memory.data.tasks[0]?.state).toBe('stopped');
    expect(memory.data.taskClosures[0]?.phase).toBe('abandoned');
    expect(memory.data.audit).toEqual([]);
    expect(memory.data.segmentRuns.map((run) => run.prNumber).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      3137, 99999,
    ]);
  });

  it('写入前或写入后外部核对没过，都回 stale 且整笔回到原样', async () => {
    const before = store();
    expect(await before.casCorrectMerged({ ...input, verify: async () => false })).toBe('stale');
    expect(before.data.tasks[0]?.state).toBe('stopped');
    expect(before.data.audit).toEqual([]);

    const after = store();
    let seen = 0;
    const onceThenFail = async () => {
      seen += 1;
      return seen === 1;
    };
    expect(await after.casCorrectMerged({ ...input, verify: onceThenFail })).toBe('stale');
    expect(seen).toBe(2);
    expect(after.data.tasks[0]?.state).toBe('stopped');
    expect(after.data.taskClosures[0]?.phase).toBe('abandoned');
    expect(after.data.taskClosures[0]?.updatedAt).toBe(WHEN);
    expect(after.data.stateChanges.some((row) => row.to === 'done')).toBe(false);
    expect(after.data.audit).toEqual([]);

    const ok = store();
    expect(await ok.casCorrectMerged({ ...input, verify: async () => true })).toBe('corrected');
    expect(ok.data.tasks[0]?.state).toBe('done');
  });

  it('两个并发纠正同时到达：外部核对时让出，只有一次写入，另一次回 stale', async () => {
    const memory = store();
    const slowVerify = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    };
    const [a, b] = await Promise.all([
      memory.casCorrectMerged({ ...input, verify: slowVerify }),
      memory.casCorrectMerged({ ...input, verify: slowVerify }),
    ]);
    expect([a, b].sort()).toEqual(['corrected', 'stale']);
    expect(
      memory.data.audit.filter((row) => row.action === CORRECT_MERGED_AUDIT_ACTION && row.ok),
    ).toHaveLength(1);
    expect(memory.data.stateChanges.filter((row) => row.to === 'done')).toHaveLength(1);
  });

  it('任务栅栏同一任务串行，不同任务互不等', async () => {
    const memory = store();
    const order: string[] = [];
    const slow = memory.withTaskFence(TASK, async () => {
      order.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('a:end');
      return 'a';
    });
    const next = memory.withTaskFence(TASK, async () => {
      order.push('b');
      return 'b';
    });
    const other = memory.withTaskFence('other-task', async () => {
      order.push('other');
      return 'other';
    });
    expect(await Promise.all([slow, next, other])).toEqual(['a', 'b', 'other']);
    expect(order.indexOf('a:end')).toBeLessThan(order.indexOf('b'));
  });

  it('开着的会话或更新时间变了就不写', async () => {
    const memory = store();
    memory.data.runs.push({
      id: 'live',
      taskId: TASK,
      stage: 'execute',
      routeId: 'route',
      whyRoute: 'test',
      queuedAt: WHEN,
    });
    expect(await memory.casCorrectMerged(input)).toBe('stale');
    expect(memory.data.tasks[0]?.state).toBe('stopped');
    expect(memory.data.audit).toEqual([]);
  });
});
