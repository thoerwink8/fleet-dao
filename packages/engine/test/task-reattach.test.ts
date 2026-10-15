// 动手会话脱开引擎跑、引擎换版本后接回（#2238）：runSegment 交回 detached，工作流隔一会儿带上 attach 再调同一段，
// 不算失败、不重新选路、不起新会话。真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import {
  type RunSegmentResult,
  SEGMENT_DETACHED,
  type TaskRun,
  type TaskWorkflowInput,
} from '../src/task-contract.ts';
import { freshRepo, useEnv, withWorker } from './helpers.ts';
import { OK_SEGMENT, scripted } from './task-script.ts';

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

const ATTACH = { runId: 'run-1', startedAt: '2026-10-15T05:22:12.000Z' };
const DETACHED: RunSegmentResult = {
  ok: false,
  runId: 'run-1',
  outcome: SEGMENT_DETACHED,
  evidence: { code: 'engine_stop', message: '引擎要走了：动手会话脱开接着跑', quotaExhausted: false },
  detached: ATTACH,
};

describe('动手会话脱开引擎跑、引擎换版本后接回（#2238）', { timeout: 90_000 }, () => {
  it('交回 detached：隔一会儿带上 attach 再调同一段（老引擎还在排空又交回一次也照接），接回跑完照常往下走；不算失败、不重新选路', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = scripted({ segment: async (_i, n) => (n <= 2 ? DETACHED : OK_SEGMENT) });
    const run = await withWorker(
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
    expect(run).toMatchObject({ outcome: 'merged' });
    expect(calls.segment).toHaveLength(3);
    const [first, second, third] = calls.segment;
    expect(first).not.toHaveProperty('attach');
    expect(second?.attach).toEqual(ATTACH);
    expect(third?.attach).toEqual(ATTACH);
    // 同一段：同一条路由、同一份交代，只多了 attach
    const { attach: _a, ...rest } = second ?? ({} as never);
    expect(rest).toEqual(first);
    expect(world.count('pickRoute')).toBe(1);
    // 不当成失败：没有停下等人、没有提醒
    expect(world.alerts).toEqual([]);
  });
});
