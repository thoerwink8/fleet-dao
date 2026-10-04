// 驾驶舱 → 引擎这条链上引擎这一半的钉子（#901，chain-first）：真的任务工作流（Temporal 测试服务端）停着等人时，
// 用 shared/task-signals.ts 里的名字（驾驶舱后端 api/src/cockpit.ts 就是拿同一份发信号）和后端实际发的参数形状叫它，
// 它得醒、得退出；用以前后端发的老名字（pause / resume / stop 这些，引擎里没人听）叫它，它纹丝不动——这就是断链的样子。
// 后端那一半（编号拼 task:<仓>#<号>、名字取自同一份）在 packages/api/test/signal-chain.test.ts。

import { randomUUID } from 'node:crypto';
import { TASK_SIGNAL_NAMES } from '@fleet-dao/shared/task-signals';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import {
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskContinueSignal,
  taskRouteWakeSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { goodBrief, scripted } from './task-script.ts';

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

const start = (q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> =>
  env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber),
    args: [i],
  });

const parkedStatus = (h: WorkflowHandle) =>
  pollQuery(
    () => h.query<TaskStatus>(taskStatusQuery),
    (s) => s.waiting?.kind === 'human',
    '停下等人',
  );

/** 读交代第一次缺栏、第二次齐：停下等人，只有「继续」才会让它往下走。 */
const parksOnce = () =>
  scripted({
    brief: (n) =>
      n === 1 ? { ok: false, problems: [{ field: '场景', why: '缺' }] } : { ok: true, brief: goodBrief() },
  });

describe('任务工作流听的信号名，和驾驶舱后端发的是同一份', { timeout: 60_000 }, () => {
  it('引擎注册的信号名就是 shared/task-signals.ts 里那三个（后端不会比引擎先改名）', () => {
    expect(taskContinueSignal.name).toBe(TASK_SIGNAL_NAMES.continue);
    expect(taskAbandonSignal.name).toBe(TASK_SIGNAL_NAMES.abandon);
    expect(taskRouteWakeSignal.name).toBe(TASK_SIGNAL_NAMES.routeWake);
    expect(Object.values(TASK_SIGNAL_NAMES)).toEqual(['taskContinue', 'taskAbandon', 'taskRouteWake']);
  });

  it('停着等人：按名字发 taskContinue（后端的参数形状 { by }）它接着走，做完', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = parksOnce();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await parkedStatus(h);
        await h.signal(TASK_SIGNAL_NAMES.continue, { by: 'user-1' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.brief).toBe(2);
  });

  it('停着等人：按名字发 taskAbandon（后端的参数形状 { by, reason }）它收尾退出', async () => {
    const world = createFakeWorld();
    const { tasks } = parksOnce();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await parkedStatus(h);
        await h.signal(TASK_SIGNAL_NAMES.abandon, { by: 'user-1', reason: '驾驶舱上点了叫停' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(world.states.at(-1)).toMatchObject({ state: 'stopped' });
  });

  it('以前后端发的老名字（resume、stop、pause、reroute、answer、requireApproval、agentEvent）：工作流不理，仍然停着', async () => {
    const world = createFakeWorld();
    const { tasks, calls } = parksOnce();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await parkedStatus(h);
        for (const name of [
          'resume',
          'stop',
          'pause',
          'reroute',
          'answer',
          'requireApproval',
          'agentEvent',
        ]) {
          await h.signal(name, { by: 'user-1', reason: '老名字' });
        }
        // 查询和信号走同一条任务通道：查得到，说明前面的信号都被工作流处理（或缓存）过了
        const s = await h.query<TaskStatus>(taskStatusQuery);
        expect(s.waiting?.kind).toBe('human');
        expect(calls.brief).toBe(1); // 没有接着往下读
        await h.signal(TASK_SIGNAL_NAMES.abandon, { by: 'user-1', reason: '收工' });
        await h.result();
      },
      { tasks },
    );
  });
});
