// 推分支被卫生检查拦下（patched('hygiene-blocked-handoff')）：不在 push 这一步里原地重推。
// 第一次拦下：命中处（文件:行 规则，不带命中原文）进下一轮动手会话。
// 同一处再拦（会话交了新提交，命中处仍一字不差）：停下等人。
// 老历史没有这个标记，重放仍走 step 里的重推（replay.test.ts）；新跑的工作流标记为真，走这里。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { PortError } from '../src/ports.ts';
import type { TaskRun, TaskStatus, TaskWorkflowInput } from '../src/task-contract.ts';
import { taskAbandonSignal, taskStatusQuery } from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

const FILE = 'packages/adapters/test/quota/grok.test.ts';
const SPOTS = [`${FILE}:147 token`, `${FILE}:148 token`];
const MESSAGE = `卫生检查拦下了要公开的内容：${SPOTS.join('；')}`;
/** 只放在 details 里。反馈和停下的原因里都不能出现它。 */
const SECRET = 'matched-original-text';

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

function blocked(): PortError {
  return new PortError('HYGIENE_BLOCKED', MESSAGE, {
    retryable: false,
    details: {
      findings: [
        { path: FILE, line: 147, rule: 'token', match: SECRET },
        { path: FILE, line: 148, rule: 'token', match: SECRET },
      ],
    },
  });
}

describe('卫生检查拦下推分支，退回会话', { timeout: 60_000 }, () => {
  it('第一次被拦：下一轮会话的反馈里有命中处；会话改过仍是同一处：停下等人', async () => {
    const world = createFakeWorld({ push: () => blocked() });
    const { tasks, calls } = scripted();
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const s = await statusUntil(h, parked, '同一处再被卫生检查拦下，停下等人');
        expect(s.waiting?.detail).toContain('一字不差');
        expect(s.waiting?.detail).toContain(SPOTS[0]);
        expect(s.waiting?.detail).toContain(SPOTS[1]);
        expect(s.waiting?.detail).not.toContain(SECRET);
        expect(s.lastProblem).toContain(SPOTS[0]);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'abandoned', prNumber: null });
    // 第一轮会话交完才被拦；拦下之后又起了一轮，反馈里有命中处。没有第三轮。
    expect(calls.segment).toHaveLength(2);
    const first = calls.segment[0]?.feedback.join('\n') ?? '';
    const second = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(first).not.toContain(SPOTS[0]);
    expect(second).toContain(SPOTS[0]);
    expect(second).toContain(SPOTS[1]);
    expect(second).toContain('把这些从提交里拿掉再交');
    expect(second).not.toContain(SECRET);
    // 原地重推的话，两次推之间不会再起会话。这里两次推，中间隔着第二轮会话。
    expect(world.count('pushBranch')).toBe(2);
    expect(world.count('openPr')).toBe(0);
    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]).toMatchObject({
      level: 'stuck',
      title: expect.stringContaining('一字不差'),
      detail: expect.stringContaining(SPOTS[0]),
    });
    expect(world.alerts[0]?.detail).not.toContain(SECRET);
    expect(world.alerts[0]?.title).not.toContain(SECRET);
  });

  it('会话把拦下的内容拿掉了：下一轮推上去、开 PR、合并', async () => {
    const world = createFakeWorld({
      push: (_input, n) => (n === 1 ? blocked() : undefined),
    });
    const { tasks, calls } = scripted();
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
    const second = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(second).toContain(SPOTS[0]);
    expect(second).toContain(SPOTS[1]);
    expect(second).not.toContain(SECRET);
    expect(calls.segment[0]?.feedback.join('\n') ?? '').not.toContain(SPOTS[0]);
  });
});
