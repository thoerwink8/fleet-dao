// 推分支并主线撞上内容冲突（#1303）：假会话，不起真会话。
// 交回时树里的冲突由读交付的 conflicts 代表；推分支抛 MERGE_CONFLICT 时不在这一步里原地重试，意见进下一轮会话。
// 会话解掉并提交（conflicts 空）就继续推；不动则第二轮带「上一轮没解」，仍不动才挂起，提醒里写冲突文件和树的位置。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, fakeHead } from '../src/fakes.ts';
import { PortError } from '../src/ports.ts';
import type { DeliveryRead, TaskRun, TaskStatus, TaskWorkflowInput } from '../src/task-contract.ts';
import { taskAbandonSignal, taskStatusQuery } from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

const FILE = 'packages/engine/src/real/index.ts';
const RESOLVE = '解完 `git add` 并提交';

function input(): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    title: '给驾驶舱加状态',
  };
}

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber),
    args: [i],
  });
}

const statusOf = (h: WorkflowHandle): Promise<TaskStatus> => h.query(taskStatusQuery);
const statusUntil = (h: WorkflowHandle, check: (s: TaskStatus) => boolean, what: string) =>
  pollQuery(() => statusOf(h), check, what);
const parked = (s: TaskStatus) => s.waiting?.kind === 'human';

function delivered(n: number, conflicts: string[]): DeliveryRead {
  return {
    head: fakeHead(100 + n),
    commits: 1,
    changedFiles: [FILE],
    leftover: [],
    conflicts,
  };
}

/** 第一次推并主线撞上内容冲突；之后的推当成会话已经解完。 */
function conflictOnce() {
  return createFakeWorld({
    push: (_input, n) =>
      n === 1
        ? new PortError(
            'MERGE_CONFLICT',
            `推之前把最新主线 72a33cb 并进来有冲突：${FILE}。树里留着冲突标记，${RESOLVE}`,
            {
              retryable: false,
              details: { mainline: 'a'.repeat(40), conflictFiles: [FILE], pending: true },
            },
          )
        : undefined,
  });
}

/** 没跟踪的文件挡着，合并还没开始：原文让会话自己 git merge 这个提交。 */
const BLOCKED_SHA = 'b'.repeat(40);
const BLOCKED_FILE = 'b.ts';
const BLOCKED_MESSAGE = `推之前把最新主线 ${BLOCKED_SHA.slice(0, 7)} 并进来有冲突：${BLOCKED_FILE}。在树里 git merge ${BLOCKED_SHA} 解掉冲突、提交后再交`;

function blockedError(): PortError {
  return new PortError('MERGE_CONFLICT', BLOCKED_MESSAGE, {
    retryable: false,
    details: { mainline: BLOCKED_SHA, conflictFiles: [BLOCKED_FILE], pending: false },
  });
}

function blockedOnce() {
  return createFakeWorld({
    push: (_input, n) => (n === 1 ? blockedError() : undefined),
  });
}

function blockedAlways() {
  return createFakeWorld({
    push: () => blockedError(),
  });
}

describe('冲突交回会话（#1303）', { timeout: 60_000 }, () => {
  it('会话把冲突解掉并提交：下一轮继续推、开 PR、合并，不再提「上一轮没解」', async () => {
    const world = conflictOnce();
    const { tasks, calls } = scripted({
      delivery: (n) => delivered(n, []),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('pushBranch')).toBe(2);
    expect(world.count('openPr')).toBe(1);
    expect(world.alerts).toEqual([]);
    const feedback = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(feedback).toContain(FILE);
    expect(feedback).toContain(RESOLVE);
    expect(feedback).not.toContain('上一轮没解');
    expect(calls.segment[0]?.feedback.join('\n') ?? '').not.toContain(RESOLVE);
  });

  it('【故意造出的失败】会话不动、树里还有冲突标记：不算交活也不推下一步；第二轮带「上一轮没解」，仍不动才挂起', async () => {
    const world = conflictOnce();
    const { tasks, calls } = scripted({
      delivery: (n) => delivered(n, n === 1 ? [] : [FILE]),
    });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const s = await statusUntil(h, parked, '冲突没解，挂起');
        expect(s.waiting?.detail).toContain('和上一次的原文一字不差');
        expect(s.waiting?.detail).toContain(FILE);
        expect(s.waiting?.detail).toContain(`/fake/worktrees/${i.taskId}/`);
        expect(s.lastProblem).toContain(FILE);
        expect(s.lastProblem).toContain(`/fake/worktrees/${i.taskId}/`);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'abandoned', prNumber: null });
    expect(calls.segment).toHaveLength(3);
    const second = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(second).toContain(FILE);
    expect(second).toContain(RESOLVE);
    expect(second).not.toContain('上一轮没解');
    const third = calls.segment[2]?.feedback.join('\n') ?? '';
    expect(third).toContain('上一轮没解');
    expect(third).toContain(FILE);
    expect(third).toContain(RESOLVE);
    // 第一轮推失败之后交回会话；后面两轮树里还有标记，不再推、不开 PR
    expect(world.count('pushBranch')).toBe(1);
    expect(world.count('openPr')).toBe(0);
    expect(world.alerts[0]).toMatchObject({
      level: 'stuck',
      title: expect.stringContaining('和上一次的原文一字不差'),
      detail: expect.stringContaining(FILE),
    });
    expect(world.alerts[0]?.detail).toContain(`/fake/worktrees/${i.taskId}/`);
    expect(world.alerts[0]?.title).toContain(`/fake/worktrees/${i.taskId}/`);
  });

  it('合并还没开始：交回的仍是自己 git merge 那个提交，不说树里留着冲突标记', async () => {
    const world = blockedOnce();
    const { tasks, calls } = scripted({
      delivery: (n) => delivered(n, []),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('pushBranch')).toBe(2);
    const feedback = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(feedback).toContain(`git merge ${BLOCKED_SHA}`);
    expect(feedback).toContain('b.ts');
    expect(feedback).not.toContain('树里留着冲突标记');
    expect(feedback).not.toContain('上一轮没解');
    expect(calls.segment[0]?.feedback.join('\n') ?? '').not.toContain('git merge');
  });

  it('合并还没开始、会话仍不并：第二轮带「上一轮没解」，仍不动才挂起，提醒里有文件和树', async () => {
    const world = blockedAlways();
    const { tasks, calls } = scripted({
      delivery: (n) => delivered(n, []),
    });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const s = await statusUntil(h, parked, '合并没开始、会话仍不并，挂起');
        expect(s.waiting?.detail).toContain('和上一次的原文一字不差');
        expect(s.waiting?.detail).toContain('b.ts');
        expect(s.waiting?.detail).toContain(`/fake/worktrees/${i.taskId}/`);
        expect(s.lastProblem).toContain('b.ts');
        expect(s.lastProblem).toContain(`/fake/worktrees/${i.taskId}/`);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'abandoned', prNumber: null });
    expect(calls.segment).toHaveLength(3);
    const second = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(second).toContain(`git merge ${BLOCKED_SHA}`);
    expect(second).not.toContain('树里留着冲突标记');
    expect(second).not.toContain('上一轮没解');
    const third = calls.segment[2]?.feedback.join('\n') ?? '';
    expect(third).toContain('上一轮没解');
    expect(third).toContain(`git merge ${BLOCKED_SHA}`);
    expect(third).not.toContain('树里留着冲突标记');
    expect(world.count('pushBranch')).toBe(3);
    expect(world.count('openPr')).toBe(0);
    expect(world.alerts[0]?.detail).toContain('b.ts');
    expect(world.alerts[0]?.detail).toContain(`/fake/worktrees/${i.taskId}/`);
  });
});
