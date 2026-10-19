import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, fakeHead } from '../src/fakes.ts';
import {
  type ArmAutoMergeInput,
  type ArmAutoMergeResult,
  type MergeNowInput,
  type TaskRun,
  type TaskStatus,
  taskContinueSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, waitUntil, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const env = useEnv();
const parked = (h: WorkflowHandle, alerts: number) =>
  pollQuery(
    () => h.query<TaskStatus>(taskStatusQuery),
    (s) => s.waiting?.kind === 'human' && s.doing?.includes('停下') === true,
    `第 ${alerts} 次停下等继续`,
  );

function synced(n: number): ArmAutoMergeResult {
  return { armed: false, merged: false, headMoved: fakeHead(600 + n), syncedMain: true };
}
function exhausted(i: ArmAutoMergeInput): ArmAutoMergeResult {
  return {
    armed: false,
    merged: false,
    why: '同步次数已用完',
    mainSyncBudgetExhausted: { prNumber: i.prNumber, headSha: i.expectedHead, used: i.syncedBehind ?? 0 },
  };
}

async function start(q: string): Promise<WorkflowHandle> {
  const repo = freshRepo();
  return env().client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(repo, 12),
    args: [{ schemaVersion: 1, taskId: randomUUID(), repo, issueNumber: 12, title: '同步预算恢复' }],
  });
}

describe('同步主线预算：精确停法消费新继续', { timeout: 60_000 }, () => {
  it('运行中发继续不能清掉已用次数或预授权下一次耗尽', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      arm: (n, i) => (n <= 3 ? synced(n) : n === 4 ? exhausted(i) : { armed: true, merged: false }),
    });
    let inFlight = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withWorker(
      env(),
      world,
      async (q) => {
        const h = await start(q);
        await waitUntil(() => inFlight, '第三次同步活动正在跑');
        await h.signal(taskContinueSignal, { by: 'frank' });
        release();
        await parked(h, 1);
        expect(calls.arm).toBe(4);
        expect(calls.armInputs.at(-1)?.syncedBehind).toBe(3);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result();
      },
      {
        tasks,
        wrapActivities: (acts) => ({
          ...acts,
          armAutoMerge: async (i) => {
            const r = await acts.armAutoMerge(i);
            if (i.syncedBehind === 2) {
              inFlight = true;
              await gate;
            }
            return r;
          },
        }),
      },
    );
    expect(calls.armInputs.at(-1)?.syncedBehind).toBeUndefined();
  });

  it('等合并冲突同步也共用预算，达到上限后一次明确继续能再同步且验新头', async () => {
    const world = createFakeWorld({ sync: (_i, n) => ({ state: 'clean', head: fakeHead(800 + n) }) });
    const { tasks, calls } = scripted({
      merged: (n) => (n <= 5 ? { state: 'conflict', detail: 'GitHub 报冲突' } : { state: 'merged' }),
    });
    const run = await withWorker(
      env(),
      world,
      async (q) => {
        const h = await start(q);
        await parked(h, 1);
        expect(world.count('syncMainline')).toBe(3);
        expect(calls.armInputs.at(-1)?.syncedBehind).toBe(3);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('syncMainline')).toBe(4);
    expect(calls.armInputs.map((i) => i.syncedBehind)).toEqual([undefined, 1, 2, 3, 1]);
    expect(calls.verify.map((i) => i.headSha)).toEqual([
      fakeHead(101),
      ...[1, 2, 3, 4].map((n) => fakeHead(800 + n)),
    ]);
  });

  it('每段最多三次；同次停下重复继续只续一段，新头仍逐一过 CI、冷验收与路径闸', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      arm: (n, i) => (n === 4 || n === 8 ? exhausted(i) : n < 9 ? synced(n) : { armed: true, merged: false }),
    });
    const run = await withWorker(
      env(),
      world,
      async (q) => {
        const h = await start(q);
        await parked(h, 1);
        expect(calls.arm).toBe(4);
        await Promise.all([
          h.signal(taskContinueSignal, { by: 'frank' }),
          h.signal(taskContinueSignal, { by: 'frank' }),
        ]);
        await pollQuery(
          () => h.query<TaskStatus>(taskStatusQuery),
          (s) => s.waiting?.kind === 'human' && world.alerts.length === 2,
          '第二段也耗尽',
        );
        expect(calls.arm).toBe(8);
        expect(world.alerts).toHaveLength(2);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.armInputs.map((i) => i.syncedBehind)).toEqual([
      undefined,
      1,
      2,
      3,
      undefined,
      1,
      2,
      3,
      undefined,
    ]);
    const heads = [fakeHead(101), ...[1, 2, 3, 5, 6, 7].map((n) => fakeHead(600 + n))];
    expect(calls.verify.map((i) => i.headSha)).toEqual(heads);
    expect(world.callsOf('waitCi').map((c) => c.input.head)).toEqual(heads);
    expect(calls.guarded).toBe(heads.length);
  });

  it('旧结果、普通错误和身份不符不续预算；旧历史重新分类后仍要下一次明确继续', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({
      arm: (n, i) => {
        if (n <= 3) return synced(n);
        if (n === 4) return { armed: false, merged: false, why: '连着 3 次同步主线后仍落后' };
        const typed = exhausted(i);
        if (n === 5)
          typed.mainSyncBudgetExhausted = { prNumber: i.prNumber + 1, headSha: i.expectedHead, used: 3 };
        if (n === 6)
          typed.mainSyncBudgetExhausted = { prNumber: i.prNumber, headSha: fakeHead(999), used: 3 };
        if (n === 7)
          typed.mainSyncBudgetExhausted = { prNumber: i.prNumber, headSha: i.expectedHead, used: 2 };
        return n <= 8 ? typed : { armed: true, merged: false };
      },
    });
    await withWorker(
      env(),
      world,
      async (q) => {
        const h = await start(q);
        for (let n = 4; n <= 8; n++) {
          await pollQuery(
            () => h.query<TaskStatus>(taskStatusQuery),
            (s) => s.waiting?.kind === 'human' && world.alerts.length === n - 3,
            `停下 ${n - 3}`,
          );
          expect(calls.arm).toBe(n);
          expect(calls.armInputs.at(-1)?.syncedBehind).toBe(3);
          expect(world.alerts.at(-1)?.title).toBe(n === 8 ? '主线同步预算已用完' : '自动合并没挂上');
          await h.signal(taskContinueSignal, { by: 'frank' });
        }
        return h.result();
      },
      { tasks },
    );
    expect(calls.armInputs.map((i) => i.syncedBehind)).toEqual([undefined, 1, 2, 3, 3, 3, 3, 3, undefined]);
  });

  it('不强制 CI 的直接合并也能有限续段，沿用该仓原有 CI 模式', async () => {
    const world = createFakeWorld();
    const inputs: MergeNowInput[] = [];
    const { tasks, calls } = scripted({
      ciPolicy: () => ({ mode: 'off' }),
      mergeNow: (n, i) => {
        inputs.push(i);
        if (n <= 3)
          return { merged: false, reason: 'behind_main', headMoved: fakeHead(700 + n), syncedMain: true };
        if (n === 4)
          return {
            merged: false,
            reason: 'behind_main',
            mainSyncBudgetExhausted: {
              prNumber: i.prNumber,
              headSha: i.expectedHead,
              used: i.syncedBehind ?? 0,
            },
          };
        return { merged: true, mergeCommit: fakeHead(900) };
      },
    });
    await withWorker(
      env(),
      world,
      async (q) => {
        const h = await start(q);
        await parked(h, 1);
        expect(calls.merge).toBe(4);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result();
      },
      { tasks },
    );
    expect(inputs.map((i) => i.syncedBehind)).toEqual([undefined, 1, 2, 3, undefined]);
    expect(world.count('waitCi')).toBe(0);
    expect(calls.verify).toEqual([]);
  });
});
