// 等路由时把「在做什么」落库（#2863，patched('route-wait-mirror')）：选路回要等，睡之前写「等路由：<原因>」；
// 同一原因连等不重复写、原因变了再写一次；选到路由起会话后 doing 换回动手那一句。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import type { PickRouteResult } from '../src/ports.ts';
import type { TaskRun, TaskWorkflowInput } from '../src/task-contract.ts';
import { freshRepo, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

const wait = (reason: string, tail: string, waitFor: 'slot' | 'quota' = 'slot'): PickRouteResult => ({
  ok: false,
  waitFor,
  detail: `${reason}（${tail}）`,
  retryAfterSeconds: 30,
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

describe('等路由落库 · 任务工作流', { timeout: 60_000 }, () => {
  it('同一原因连等三次只落库一次；原因变了再落一次；选到路由后换回动手那一句', async () => {
    const seq: PickRouteResult[] = [
      wait('UI阶段暂时派不了，在等熔断的试探结果', '第 29 条 A'),
      wait('UI阶段暂时派不了，在等熔断的试探结果', '第 29 条 B'),
      wait('UI阶段暂时派不了，在等熔断的试探结果', '第 30 条 C'),
      wait('UI阶段暂时派不了，在等空位', '池满了'),
    ];
    const world = createFakeWorld({ route: (_i, n) => seq[n - 1] });
    const { tasks } = scripted();
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
          taskQueue: q,
          workflowId: taskWorkflowId(i.repo, i.issueNumber),
          args: [i],
        });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('pickRoute')).toBe(5);
    const doings = world.states.map((s) => s.doing);
    const fuse = doings.filter((d) => d === '等路由：UI阶段暂时派不了，在等熔断的试探结果');
    const slot = doings.filter((d) => d === '等路由：UI阶段暂时派不了，在等空位');
    expect(fuse).toHaveLength(1);
    expect(slot).toHaveLength(1);
    const lastWait = doings.lastIndexOf('等路由：UI阶段暂时派不了，在等空位');
    const after = doings.slice(lastWait + 1).find((d) => d?.includes('动手'));
    expect(after).toMatch(/^第 1 轮：.* 动手/);
    expect(doings.slice(lastWait + 1)).not.toContain('等路由：UI阶段暂时派不了，在等空位');
  });
});
