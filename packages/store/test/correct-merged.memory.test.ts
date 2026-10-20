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

  it('两个并发纠正同时到达：只有一次写入，另一次回 stale', async () => {
    const memory = store();
    const [a, b] = await Promise.all([memory.casCorrectMerged(input), memory.casCorrectMerged(input)]);
    expect([a, b].sort()).toEqual(['corrected', 'stale']);
    expect(
      memory.data.audit.filter((row) => row.action === CORRECT_MERGED_AUDIT_ACTION && row.ok),
    ).toHaveLength(1);
  });

  it('起代意图没结就不写；意图改了更新时间，旧的期望也对不上；落了已结、换上新的更新时间才写', async () => {
    const memory = store();
    const actor = { kind: 'ops', id: 'founder', via: 'ops' } as const;
    const begun = await memory.beginTaskStart({ taskId: TASK, allowed: ['stopped'], actor });
    if (!begun.ok) throw new Error('意图没落上');
    const bumped = Date.parse('2026-10-19T02:00:00.000Z');
    expect(await memory.casCorrectMerged(input)).toBe('stale');
    expect(await memory.casCorrectMerged({ ...input, expectedUpdatedAtMs: bumped })).toBe('stale');
    expect(memory.data.tasks[0]?.state).toBe('stopped');
    await memory.settleTaskStart({
      taskId: TASK,
      intent: begun.intent,
      claimed: null,
      outcome: 'not_started',
      actor,
    });
    expect(await memory.casCorrectMerged({ ...input, expectedUpdatedAtMs: bumped })).toBe('corrected');
    expect(await memory.beginTaskStart({ taskId: TASK, allowed: ['stopped'], actor })).toEqual({
      ok: false,
      state: 'done',
    });
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
