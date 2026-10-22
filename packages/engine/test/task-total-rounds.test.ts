// 每张单总轮数上限（#3603）：这一代累计动手到 MAX_TOTAL_ROUNDS 就贴「本机做」交还本机、留言、停下；「继续」不清零，
// 不带原因的「继续」不放行，带了原因才再给一段。真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { continueNeedsReason, totalRoundsTitle } from '@fleet-dao/shared/continue-exhausted';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { PortError } from '../src/ports.ts';
import {
  MAX_IMPLEMENT_ROUNDS,
  MAX_TOTAL_ROUNDS,
  PARK_CODE_TOTAL_ROUNDS,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskContinueSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

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

const statusUntil = (h: WorkflowHandle, check: (s: TaskStatus) => boolean, what: string) =>
  pollQuery(() => h.query(taskStatusQuery), check, what);
const parkedAt = (seq: number) => (s: TaskStatus) => s.waiting?.kind === 'human' && (s.park?.seq ?? 0) >= seq;
const RED = { state: 'red' as const, failedChecks: ['test (engine)'], digest: 'FAIL a.test.ts' };

describe('每张单总轮数上限（#3603）', { timeout: 120_000 }, () => {
  it('上限 6 轮、继续不清零：到顶贴「本机做」留言、停下；不带原因的「继续」原样再停，带原因的才再给一段', async () => {
    expect(MAX_TOTAL_ROUNDS).toBe(6);
    // CI 前 6 轮都红，第 7 轮绿：只有带原因放行之后才走得到第 7 轮
    const world = createFakeWorld({ ci: (_i, n) => (n <= MAX_TOTAL_ROUNDS ? RED : undefined) });
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const first = await statusUntil(h, parkedAt(1), '累计 6 轮到顶停下');
        expect(calls.segment).toHaveLength(MAX_TOTAL_ROUNDS);
        expect(first.lastProblem).toContain(totalRoundsTitle(MAX_TOTAL_ROUNDS));
        expect(first.park).toMatchObject({ kind: 'other', code: PARK_CODE_TOTAL_ROUNDS });
        // 入口认得出这一停：不带原因不发
        expect(continueNeedsReason(first.lastProblem)).toContain('要写明为什么');
        // 交还本机：一次留言加贴标签，键绑着这一代和这个上限
        expect(calls.handBack).toHaveLength(1);
        expect(calls.handBack[0]?.key).toMatch(/^total-rounds:.+:6$/);
        expect(calls.handBack[0]?.body).toContain('已贴「本机做」交还本机');
        expect(calls.handBack[0]?.body).toContain('--note');
        expect(first.waiting?.detail).toContain('交还本机');

        // 不带原因（人点的、没有 note）：不放行，原样再停一次，不起会话
        const seq = first.park?.seq ?? 0;
        await h.signal(taskContinueSignal, { by: 'frank' });
        const again = await statusUntil(h, parkedAt(seq + 1), '没带原因，原样再停');
        expect(again.lastProblem).toContain(totalRoundsTitle(MAX_TOTAL_ROUNDS));
        expect(calls.segment).toHaveLength(MAX_TOTAL_ROUNDS);
        expect(world.states.some((s) => s.doing.includes('「继续」没带原因，不放行'))).toBe(true);
        // 空白也算没带
        await h.signal(taskContinueSignal, { by: 'frank', note: '   ' });
        await statusUntil(h, parkedAt(seq + 2), '空白原因，原样再停');
        expect(calls.segment).toHaveLength(MAX_TOTAL_ROUNDS);

        // 带原因：放行。PR 已开、头已记录，照「继续」的老做法先重看这个 PR 的 CI（第 7 次 CI 绿），合上
        await h.signal(taskContinueSignal, { by: 'frank', note: 'CI 台修好了，重看一次' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('waitCi')).toBe(MAX_TOTAL_ROUNDS + 1);
    expect(calls.segment).toHaveLength(MAX_TOTAL_ROUNDS);
    // 只交还一次：同一个上限不重复留言
    expect(calls.handBack).toHaveLength(1);
    expect(world.states.some((s) => s.doing.includes(`再给 ${MAX_IMPLEMENT_ROUNDS} 轮`))).toBe(true);
  });

  it('放行之后累计不清零：再做满一段又到顶（上限 6 + 3），照样要原因', async () => {
    const limit = MAX_TOTAL_ROUNDS + MAX_IMPLEMENT_ROUNDS;
    const world = createFakeWorld({ ci: () => RED });
    const { tasks, calls } = scripted();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const first = await statusUntil(h, parkedAt(1), '第一次到顶');
        await h.signal(taskContinueSignal, { by: 'frank', note: '再试一段' });
        const second = await statusUntil(
          h,
          (s) =>
            parkedAt((first.park?.seq ?? 0) + 1)(s) &&
            (s.lastProblem ?? '').includes(totalRoundsTitle(limit)),
          '第二次到顶',
        );
        expect(calls.segment).toHaveLength(limit);
        expect(second.park?.code).toBe(PARK_CODE_TOTAL_ROUNDS);
        expect(calls.handBack.map((c) => c.key.split(':').at(-1))).toEqual(['6', '9']);
        await h.terminate('测完了');
      },
      { tasks },
    );
  });

  it('【故意造出的失败】交还本机没做成（贴标签报错）：照旧停下，正文写明没贴上，不装作贴过', async () => {
    const world = createFakeWorld({ ci: () => RED });
    const { tasks, calls } = scripted({
      handBack: () => {
        throw new PortError('PERMISSION_DENIED', '没有给单子贴标签的权限', { retryable: false });
      },
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await statusUntil(h, parkedAt(1), '到顶停下');
        expect(calls.segment).toHaveLength(MAX_TOTAL_ROUNDS);
        expect(s.lastProblem).toContain(totalRoundsTitle(MAX_TOTAL_ROUNDS));
        const alert = world.alerts.find((a) => a.title.includes(totalRoundsTitle(MAX_TOTAL_ROUNDS)));
        expect(alert?.detail).toContain('「本机做」没贴上');
        expect(alert?.detail).not.toContain('已贴「本机做」交还本机');
        await h.terminate('测完了');
      },
      { tasks },
    );
  });
});
