// 受管起代先落起代意图：正常重做照常另起并落已结；已做完、不在库里的单不调 Temporal；结果未知时意图一直挂着。
import type { TaskState } from '@fleet-dao/shared';
import { createMemoryStore } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import type { TaskRedoPort } from '../src/deps.ts';
import { fencedTaskRedo } from '../src/task-generation-fence.ts';

const TASK = 'd629758a-570d-405d-be00-417b7ee6c0c7';
const WHEN = '2026-10-19T01:52:06.446Z';
const REPO = {
  id: 'repo',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: 'pnpm test',
};
const ACTOR = { kind: 'ops', id: 'founder', via: 'ops' } as const;

function storeWith(state: TaskState) {
  return createMemoryStore(
    {
      repos: [REPO],
      tasks: [
        {
          id: TASK,
          repoId: 'repo',
          issueNumber: 3114,
          title: '合成',
          rawRequest: '合成',
          requestedBy: 'test',
          state,
          priority: 0,
          createdAt: WHEN,
          executor: 'engine',
        },
      ],
      taskClosures: [{ taskId: TASK, phase: 'abandoned', updatedAt: WHEN }],
    },
    { now: () => new Date('2026-10-19T02:00:00.000Z') },
  );
}

function fakeRedo(behave: () => Promise<Awaited<ReturnType<TaskRedoPort['redo']>>>) {
  const calls: string[] = [];
  const port: TaskRedoPort = {
    async redo(input) {
      calls.push(input.taskId);
      return behave();
    },
  };
  return { port, calls };
}

const started = async () => ({
  ok: true as const,
  workflowId: 'task:thoerwink8/fleet-dao#3114:r2',
  generation: 2,
});
const input = { taskId: TASK, issueNumber: 3114, title: '合成', repo: REPO } as const;

async function pending(store: ReturnType<typeof storeWith>) {
  const ledger = await store.readCorrectMergedLedger({
    owner: 'thoerwink8',
    name: 'fleet-dao',
    issueNumber: 3114,
    prNumber: 3137,
  });
  return ledger?.task.startPending;
}

// 起成落已结、Postgres 上的意图和更新时间见 task-correct-merged-assembly.test.ts。
describe('受管起代的起代意图', () => {
  it('已做完或不在库里：意图里重读就拒绝，不调 Temporal，不落意图', async () => {
    for (const [state, taskId] of [
      ['done', TASK],
      ['stopped', 'd629758a-570d-405d-be00-000000000000'],
    ] as const) {
      const store = storeWith(state);
      const { port, calls } = fakeRedo(started);
      const outcome = await fencedTaskRedo(port, store, ACTOR).redo({ ...input, taskId });
      expect(outcome.ok).toBe(false);
      if (state === 'done')
        expect(outcome).toEqual({ ok: false, why: '这张单现在是done，只有已叫停或挂起的才能重做' });
      expect(calls).toEqual([]);
      expect(store.data.audit).toEqual([]);
    }
  });

  it('起代抛错（超时，结果未知）：意图挂着不落已结；后一次结果明确的重做覆盖掉它', async () => {
    const store = storeWith('stopped');
    const timeout = fakeRedo(async () => {
      throw new Error('4 DEADLINE_EXCEEDED');
    });
    await expect(fencedTaskRedo(timeout.port, store, ACTOR).redo(input)).rejects.toThrow('DEADLINE_EXCEEDED');
    expect(await pending(store)).toBe(true);

    const refused = fakeRedo(async () => ({ ok: false as const, why: '第 2 代还在跑' }));
    expect(await fencedTaskRedo(refused.port, store, ACTOR).redo(input)).toEqual({
      ok: false,
      why: '第 2 代还在跑',
    });
    expect(await pending(store)).toBe(false);
  });
});
