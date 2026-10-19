// 受管起代的栅栏包装：正常重做照常另起；已做完、不在库里的单不调 Temporal。
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
    },
    { now: () => new Date('2026-10-19T02:00:00.000Z') },
  );
}

function fakeRedo() {
  const calls: string[] = [];
  const port: TaskRedoPort = {
    async redo(input) {
      calls.push(input.taskId);
      return { ok: true, workflowId: 'task:thoerwink8/fleet-dao#3114:r2', generation: 2 };
    },
  };
  return { port, calls };
}

const input = { taskId: TASK, issueNumber: 3114, title: '合成', repo: REPO } as const;

describe('受管起代的栅栏包装', () => {
  it('已叫停的单照常另起一代，经栅栏调用一次', async () => {
    const store = storeWith('stopped');
    const { port, calls } = fakeRedo();
    const outcome = await fencedTaskRedo(port, store).redo(input);
    expect(outcome).toEqual({ ok: true, workflowId: 'task:thoerwink8/fleet-dao#3114:r2', generation: 2 });
    expect(calls).toEqual([TASK]);
  });

  it('已做完的单栅栏里重读就拒绝，不调 Temporal', async () => {
    const store = storeWith('done');
    const { port, calls } = fakeRedo();
    const outcome = await fencedTaskRedo(port, store).redo(input);
    expect(outcome).toEqual({ ok: false, why: '这张单现在是done，只有已叫停或挂起的才能重做' });
    expect(calls).toEqual([]);
  });

  it('不在库里的任务拒绝，不调 Temporal', async () => {
    const store = storeWith('stopped');
    const { port, calls } = fakeRedo();
    const outcome = await fencedTaskRedo(port, store).redo({
      ...input,
      taskId: 'd629758a-570d-405d-be00-000000000000',
    });
    expect(outcome.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
