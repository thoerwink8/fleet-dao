// 冷验收会话脱开引擎跑、引擎换版本后接回（#2848）：coldVerify 交回 detached，工作流隔一会儿带上 attach 再调同一次验收，
// 不算一轮、不算没过、不重新起会话；接回没接成（发版叫停了又没接回）回 retry，只重验一次，也不占全程「冷验收被拒」的次数。
// 真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import type { ColdVerifyAttach, ColdVerifyResult, TaskRun, TaskWorkflowInput } from '../src/task-contract.ts';
import { freshRepo, useEnv, withWorker } from './helpers.ts';
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

const ATTACH: ColdVerifyAttach = {
  runId: 'run-v1',
  startedAt: '2026-10-16T08:00:00.000Z',
  family: 'gpt',
  modelId: 'gpt-model',
  routeId: 'route-gpt',
  poolId: 'pool-gpt',
  cwd: '/tmp/verify-run-v1',
};
const DETACHED: ColdVerifyResult = { pass: false, problems: [], round: 1, detached: ATTACH };
/** 接回没接成（会话被发版叫停、又没接回）：活动回的 retry，不是没过。 */
const LOST: ColdVerifyResult = {
  pass: false,
  problems: [],
  round: 1,
  retry: { wait: 'slot', reason: '发版叫停了这一次验收、没接回：重验一次', afterSeconds: 30 },
};

async function runTask(tasks: ReturnType<typeof scripted>['tasks']): Promise<TaskRun> {
  const world = createFakeWorld();
  return withWorker(
    env,
    world,
    async (q) => {
      const i = input();
      const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
        taskQueue: q,
        workflowId: taskWorkflowId(i.repo, i.issueNumber),
        args: [i],
      });
      return h.result() as Promise<TaskRun>;
    },
    { tasks },
  );
}

describe('冷验收会话脱开引擎跑、引擎换版本后接回（#2848）', { timeout: 120_000 }, () => {
  it('交回 detached：带上 attach 再调同一次验收（老引擎还在排空又交回一次也照接），接回的结论照常认；不算没过、不起返工', async () => {
    const { tasks, calls } = scripted({
      verify: (_i, n) => (n <= 2 ? DETACHED : { pass: true, problems: [], round: 1 }),
    });
    const run = await runTask(tasks);
    expect(run).toMatchObject({ outcome: 'merged' });
    expect(calls.verify).toHaveLength(3);
    const [first, second, third] = calls.verify;
    expect(first).not.toHaveProperty('attach');
    expect(second?.attach).toEqual(ATTACH);
    expect(third?.attach).toEqual(ATTACH);
    // 同一次验收：同一个头、同一轮、同一份材料，只多了 attach
    const { attach: _a, ...rest } = second ?? ({} as never);
    expect(rest).toEqual(first);
    // 脱开不是没过：只动手一次
    expect(calls.segment).toHaveLength(1);
  });

  it('全程的单：接回没接成（发版叫停又没接回）回 retry，只重验一次，不占「冷验收被拒 2 次」的上限', async () => {
    // 1 脱开 → 2 接回没接成（retry）→ 3 被拒（第 1 次）→ 返工续会话 → 4 过。没接成的那次要是算被拒，
    // 第 3 次就到了 2 次的上限、停下等人，这张单永远合不上（测试超时）
    const { tasks, calls } = scripted({
      flow: () => ({ mode: 'full', source: 'label', reason: null }),
      resume: () => ({ kind: 'resume', sessionId: 'sess-1', runId: 'run-1' }),
      verify: (_i, n) =>
        n === 1
          ? DETACHED
          : n === 2
            ? LOST
            : n === 3
              ? { pass: false, problems: ['少了状态'], round: 1 }
              : { pass: true, problems: [], round: 1 },
    });
    const run = await runTask(tasks);
    expect(run).toMatchObject({ outcome: 'merged' });
    expect(calls.verify).toHaveLength(4);
    expect(calls.verify[1]?.attach).toEqual(ATTACH);
    // 没接成之后重验一次：全新的一次（不带 attach），轮数还是第 1 轮
    expect(calls.verify[2]).not.toHaveProperty('attach');
    expect(calls.verify[2]?.round).toBe(1);
    // 被拒一次才回去续会话修：动手两段
    expect(calls.segment).toHaveLength(2);
  });
});
