// 叫醒等路由的活（#194 方案 4.3）走 Temporal 测试服务端：任务工作流等路由时收到 taskRouteWake 当场重选，
// 信号没来仍按等待上限醒；叫醒后仍选不到就回去接着等（不空转）；问选路的那一刻到的叫醒不丢；多张单同时叫醒；
// 收信人不在（没这个编号、已结束）是正常的。收信失败、列不出的报警在 test/real/route-wake.test.ts。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, type FakeWorld } from '../src/fakes.ts';
import type { PickRouteResult } from '../src/ports.ts';
import { routeWaker, temporalWakeClient } from '../src/real/route-wake.ts';
import {
  type ColdVerifyResult,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskRouteWakeSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, waitUntil, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

const CAP_SECONDS = 120;
const WAIT_SLOT: PickRouteResult = {
  ok: false,
  waitFor: 'slot',
  detail: '切号还没完成',
  retryAfterSeconds: CAP_SECONDS,
};

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

const waitingSlot = (h: WorkflowHandle) =>
  pollQuery(
    () => h.query<TaskStatus>(taskStatusQuery),
    (s) => s.waiting?.kind === 'slot',
    '工作流停在等空位',
  );

const wake = (h: WorkflowHandle) => h.signal(taskRouteWakeSignal, { by: 'test', reason: '切号完成' });

/** 前 waits 次选路回「等」，之后照常派。 */
const waitFirst = (waits: number) => (_i: unknown, n: number) => (n <= waits ? WAIT_SLOT : undefined);

describe('叫醒等路由的活 · 任务工作流', { timeout: 60_000 }, () => {
  it('等路由时收到叫醒：当场重选，不睡满上限', async () => {
    const world = createFakeWorld({ route: waitFirst(1) });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitingSlot(h);
        const t0 = await env.currentTimeMs();
        await wake(h);
        await world.until(() => world.count('pickRoute') >= 2, '叫醒后又选了一次路');
        // 没在等 result()，测试服务端不跳时间：流程时间没走到上限
        expect((await env.currentTimeMs()) - t0).toBeLessThan((CAP_SECONDS * 1000) / 2);
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('pickRoute')).toBe(2);
  });

  it('信号没来：照上限醒（2 分钟兜底），不会一直等', async () => {
    const world = createFakeWorld({ route: waitFirst(1) });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitingSlot(h);
        const t0 = await env.currentTimeMs();
        const result = (await h.result()) as TaskRun;
        expect((await env.currentTimeMs()) - t0).toBeGreaterThanOrEqual(CAP_SECONDS * 1000);
        return result;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('pickRoute')).toBe(2);
  });

  it('叫醒后选路还是选不到：回去接着等满上限，不空转', async () => {
    const world = createFakeWorld({ route: waitFirst(2) });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitingSlot(h);
        const t0 = await env.currentTimeMs();
        await wake(h);
        await world.until(() => world.count('pickRoute') >= 2, '叫醒后又选了一次路');
        // 选不到又回去等了：隔一阵也不会自己再选（空转的话次数会往上涨）
        await waitingSlot(h);
        await new Promise((r) => setTimeout(r, 400));
        expect(world.count('pickRoute')).toBe(2);
        const result = (await h.result()) as TaskRun;
        // 第二次等没人叫醒，按上限醒：总共走过了至少一个上限
        expect((await env.currentTimeMs()) - t0).toBeGreaterThanOrEqual(CAP_SECONDS * 1000);
        return result;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('pickRoute')).toBe(3);
  });

  it('问选路那一刻到的叫醒不丢：选路回「等」之后不睡、直接再选', async () => {
    const world = createFakeWorld({ route: waitFirst(1), holdPorts: ['pickRoute'] });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await world.until(() => world.count('pickRoute') >= 1, '第一次选路在途');
        const t0 = await env.currentTimeMs();
        await wake(h); // 选路正挂着（读的是切号完成之前的事实）
        // 信号要真进到工作流里才放行（查询是同一条任务通道，查得到就说明前面的信号处理过了）
        await pollQuery(
          () => h.query<TaskStatus>(taskStatusQuery),
          () => true,
          '工作流收下信号',
        );
        world.releasePort('pickRoute');
        await world.until(() => world.count('pickRoute') >= 2, '没睡就再选了一次');
        expect((await env.currentTimeMs()) - t0).toBeLessThan((CAP_SECONDS * 1000) / 2);
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
  });

  it('验收等空位也能被叫醒', async () => {
    const world = createFakeWorld();
    const retry: ColdVerifyResult = {
      pass: false,
      problems: [],
      round: 1,
      retry: { wait: 'slot', reason: '验收没空位', afterSeconds: CAP_SECONDS },
    };
    const { tasks, calls } = scripted({
      verify: (_i, n) => (n === 1 ? retry : { pass: true, problems: [], round: 1 }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitingSlot(h);
        const t0 = await env.currentTimeMs();
        await wake(h);
        await world.until(() => calls.verify.length >= 2, '叫醒后又验了一次');
        expect((await env.currentTimeMs()) - t0).toBeLessThan((CAP_SECONDS * 1000) / 2);
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
  });

  it('同时叫醒多张单：每张都重选、没人报警', async () => {
    // #1764 偶发超时根因（CI run 38043069632 attempt 1 job 114187063987 / test 6/8）：
    // 两张单都停在 pauseForRoute：condition 等 taskRouteWake（记号之后到过一次就算），信号可能先于
    // 订阅到达（靠问选路前的记号不丢），也可能一张已醒去跑活动、另一张还停在 condition 或活动尚在工人手里。
    // 旧等法 Promise.all([a.result(), b.result()]) → TimeSkippingWorkflowClient.result 全局 unlockTimeSkipping；
    // 未收场那张时钟一跳即 START_TO_CLOSE（日志：WorkflowFailedError: Workflow execution timed out；
    // 栈 TimeSkippingWorkflowClient.result ← task-route-wake.test.ts:219:27；Serialized Error
    // timeoutType: 'START_TO_CLOSE'；同批 Temporal「Task not found when completing」）。
    // 全局 pickRoute>=4 也可能被一张单多次选路凑满，漏掉仍在等信号的那张。
    // 改法：按 taskId 等每张重选 → waitUntil 库 done → 查 phase；绝不 await result()（查询不解锁跳时间）。
    // 不调大 CAP_SECONDS / describe timeout。本机连跑 20 次：ok=20 fail=0，耗时 10–23s/次
    //（命令：npx vitest run packages/engine/test/task-route-wake.test.ts -t 「同时叫醒多张单」×20）。
    const world: FakeWorld = createFakeWorld({ route: waitFirst(2) });
    const { tasks } = scripted();
    const raised: string[] = [];
    // 测试服务端没有高级可见性、列不出在跑的工作流：列的这一步换成固定编号，发信号走真客户端
    let listed: string[] = [];
    const waker = routeWaker({
      client: { ...temporalWakeClient(env.client), runningTaskWorkflowIds: async () => listed },
      raise: async (a) => void raised.push(a.key),
      resolve: async () => {},
    });
    await withWorker(
      env,
      world,
      async (q) => {
        const ia = input();
        const ib = input();
        const a = await start(q, ia);
        const b = await start(q, ib);
        await waitingSlot(a);
        await waitingSlot(b);
        listed = [a.workflowId, b.workflowId];
        const t0 = await env.currentTimeMs();
        const result = await waker.wake('切号完成');
        expect(result).toMatchObject({ total: 2, sent: 2, gone: 0, failed: [] });
        // 按单等重选：全局 pickRoute>=4 可能被一张单的多次选路凑满，另一张还停在 pauseForRoute 等 taskRouteWake
        const picks = (taskId: string) =>
          world.callsOf('pickRoute').filter((c) => c.input.taskId === taskId).length;
        await world.until(() => picks(ia.taskId) >= 2 && picks(ib.taskId) >= 2, '两张单都又选了一次');
        expect((await env.currentTimeMs()) - t0).toBeLessThan((CAP_SECONDS * 1000) / 2);
        // 同 #1242：先等库里写进 done；收场用查询/库断言，绝不 await result()（见上方根因）。
        await waitUntil(
          () =>
            world.states.filter((x) => x.taskId === ia.taskId).at(-1)?.state === 'done' &&
            world.states.filter((x) => x.taskId === ib.taskId).at(-1)?.state === 'done',
          '两张单都写进 done',
        );
        const [sa, sb] = await Promise.all([
          a.query<TaskStatus>(taskStatusQuery),
          b.query<TaskStatus>(taskStatusQuery),
        ]);
        expect([sa.phase, sb.phase]).toEqual(['done', 'done']);
        expect(world.states.filter((x) => x.taskId === ia.taskId).at(-1)).toMatchObject({
          state: 'done',
        });
        expect(world.states.filter((x) => x.taskId === ib.taskId).at(-1)).toMatchObject({
          state: 'done',
        });
      },
      { tasks },
    );
    expect(raised).toEqual([]);
  });

  it('收信人不在：没这个编号、已经结束的工作流，叫醒回 gone（不抛、不报）', async () => {
    const client = temporalWakeClient(env.client);
    const cmd = { by: 'test', reason: '切号完成' };
    await expect(client.signal(`task-nobody-${randomUUID()}`, cmd)).resolves.toBe('gone');
    const world = createFakeWorld();
    const { tasks } = scripted();
    const i = input();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        await h.result();
      },
      { tasks },
    );
    await expect(client.signal(taskWorkflowId(i.repo, i.issueNumber), cmd)).resolves.toBe('gone');
  });
});
