// 后端拉起一张单的工作流（@fleet-dao/api 的 createTemporalRequirementWorkflows，#214 起起的是 Fusion）对着真的 Temporal
// 测试服务端和真的引擎工作流：类型名、输入形状两边对得上（引擎真跑完），驾驶舱和 fleet 命令的信号按原来的编号发得到，
// 同一张 issue 在跑时不起第二条（切换之前起的旧需求工作流也一样：它照旧跑完，不换成 Fusion），结束后能再起，连不上明确失败。
import { createServer } from 'node:net';
import {
  createTemporalRequirementWorkflows,
  createTemporalWorkflowControl,
  WorkflowUnavailableError,
} from '@fleet-dao/api';
import { Client, Connection } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type FusionResult,
  type FusionStatus,
  type RequirementResult,
  type RequirementStatus,
  requirementWorkflowId,
  WORKFLOW_TYPES,
} from '../src/contract.ts';
import { createFakeWorld, FAKE_ROUTES } from '../src/fakes.ts';
import type { RouteChoice } from '../src/ports.ts';
import { fusionInput, queryUntil, requirementInput, useEnv, waitUntil, withWorker } from './helpers.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

/** 本机一个刚关掉的端口：连上去必然被拒。 */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('拿不到本机端口');
  return address.port;
}

/** 开 PR 前验证只派别家：写单的是 claude（Lead）和 kimi（副手），要一条 gpt 族的路由才验得了。 */
const GPT_ROUTE: RouteChoice = {
  routeId: 'r4',
  poolId: 'p4',
  modelId: 'm3',
  family: 'gpt',
  hostId: 'cursor-agent',
};
const fusionWorld = () => createFakeWorld({ routes: [...FAKE_ROUTES, GPT_ROUTE] });

describe('后端拉起一张单的工作流（真 Temporal 测试服务端）', { timeout: 60_000 }, () => {
  it('起的是 Fusion、引擎真跑完；在跑时同一张 issue 再起回 already_running；结束后（重开）能再起', async () => {
    const taskQueue = `q-start-${Date.now()}`;
    const requirements = createTemporalRequirementWorkflows(env.client, taskQueue);
    // 后端给的就是 RequirementStartInput：没有 Fusion 自己的可选项（类别、模式……），引擎按流程配置判
    const { category: _c, profile: _p, mode: _m, ...input } = fusionInput();
    const workflowId = requirementWorkflowId(input.repo, input.issueNumber);

    // 还没有工人：工作流起来了、一直在跑，第二次（重投、重放）必然撞上
    expect(await requirements.start(input)).toBe('started');
    expect(await requirements.start({ ...input, taskId: 'another-task' })).toBe('already_running');
    const running = await env.client.workflow.getHandle(workflowId).describe();
    expect(running.status.name).toBe('RUNNING');
    expect(running.type).toBe(WORKFLOW_TYPES.fusion);

    const world = fusionWorld();
    const result = await withWorker(
      env,
      world,
      async () => (await env.client.workflow.getHandle(workflowId).result()) as FusionResult,
      { taskQueue },
    );
    expect(result).toMatchObject({ taskId: input.taskId, state: 'done', problem: null });
    // 引擎收到的输入就是后端给的那份（后端没带的可选项用引擎默认），走的是 Fusion 的 Lead 那一套
    expect(world.states.at(-1)).toMatchObject({ taskId: input.taskId, state: 'done', flowSource: 'project' });
    expect(world.callsOf('startSession').some((c) => c.input.brief.lead?.step === 'plan')).toBe(true);
    expect(world.count('writeSpecDoc')).toBe(0);

    expect(await requirements.start(input)).toBe('started');
    expect((await env.client.workflow.getHandle(workflowId).describe()).type).toBe(WORKFLOW_TYPES.fusion);
  });

  it('驾驶舱、fleet 命令的信号照旧按 req:<仓>#<号> 发到 Fusion：暂停、继续、叫停都生效', async () => {
    const taskQueue = `q-signal-${Date.now()}`;
    const requirements = createTemporalRequirementWorkflows(env.client, taskQueue);
    const control = createTemporalWorkflowControl(env.client);
    const input = fusionInput();
    const workflowId = requirementWorkflowId(input.repo, input.issueNumber);
    // Lead 写方案的会话挂着：工作流停在第 2 步，信号进来时它正在跑
    const world = createFakeWorld({
      routes: [...FAKE_ROUTES, GPT_ROUTE],
      session: (s) => (s.brief.lead?.step === 'plan' ? { hold: true } : undefined),
    });
    const result = await withWorker(
      env,
      world,
      async () => {
        expect(await requirements.start(input)).toBe('started');
        const handle = env.client.workflow.getHandle(workflowId);
        await waitUntil(() => world.held().length === 1, 'Lead 写方案的会话挂着');
        await control.signal(workflowId, { name: 'pause', by: 'founder', reason: '看一眼' });
        await queryUntil<FusionStatus>(handle, (s) => s.paused, '收到暂停');
        await control.signal(workflowId, { name: 'resume', by: 'founder' });
        await queryUntil<FusionStatus>(handle, (s) => !s.paused, '收到继续');
        // 继续之后 Lead 续同一个会话接着写（又挂着）再叫停。紧跟着「继续」就叫停，可跳时间的测试服务端偶尔把那一轮
        // 工作流任务卡住不交（真服务端上连跑 16 次都没卡，旧的需求工作流在测试服务端上也一样卡）：等到会话重新挂上
        await waitUntil(
          () => world.spawned.length === 2 && world.held().length === 1,
          'Lead 续上会话、又挂着',
        );
        await control.signal(workflowId, { name: 'stop', by: 'founder', reason: 'GitHub 上关了这张 issue' });
        return (await handle.result()) as FusionResult;
      },
      { taskQueue },
    );
    expect(result.state).toBe('stopped');
    const plans = world.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'plan');
    expect(plans.map((c) => c.input.resumeSessionId ?? null)).toEqual([null, 's1']);
    expect(world.states.at(-1)?.state).toBe('stopped');
  });

  it('切换那一刻：切换之前起的旧需求工作流还在跑，后端再起回 already_running——不起第二条、不换成 Fusion，旧的照旧收信号、跑完；之后重开才起 Fusion', async () => {
    const taskQueue = `q-switch-${Date.now()}`;
    const input = requirementInput();
    const workflowId = requirementWorkflowId(input.repo, input.issueNumber);
    // 旧后端起的：同一个编号、旧类型（和旧后端当时一样的起法）
    await env.client.workflow.start(WORKFLOW_TYPES.requirement, {
      taskQueue,
      workflowId,
      args: [input],
      workflowIdConflictPolicy: 'FAIL',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    const oldRun = await env.client.workflow.getHandle(workflowId).describe();
    expect(oldRun.type).toBe(WORKFLOW_TYPES.requirement);

    // 新后端（起 Fusion）碰上它：只回 already_running，旧的还是那一条、还是旧类型
    const requirements = createTemporalRequirementWorkflows(env.client, taskQueue);
    expect(await requirements.start(input)).toBe('already_running');
    const still = await env.client.workflow.getHandle(workflowId).describe();
    expect([still.runId, still.type, still.status.name]).toEqual([
      oldRun.runId,
      WORKFLOW_TYPES.requirement,
      'RUNNING',
    ]);

    // 旧的照旧收信号（驾驶舱暂停、继续按同一个编号发），照旧跑完
    const control = createTemporalWorkflowControl(env.client);
    const world = createFakeWorld({ plan: [{ key: 'readme', title: '改说明', touches: ['docs'] }] });
    const result = await withWorker(
      env,
      world,
      async () => {
        const handle = env.client.workflow.getHandle(workflowId);
        await control.signal(workflowId, { name: 'pause', by: 'founder' });
        await queryUntil<RequirementStatus>(handle, (s) => s.paused, '旧的收到暂停');
        await control.signal(workflowId, { name: 'resume', by: 'founder' });
        return (await handle.result()) as RequirementResult;
      },
      { taskQueue },
    );
    expect(result.state).toBe('done');
    expect(world.states.at(-1)?.taskId).toBe(input.taskId);

    // 旧的跑完了、单子重开：这回起的是 Fusion
    expect(await requirements.start(input)).toBe('started');
    const next = await env.client.workflow.getHandle(workflowId).describe();
    expect(next.type).toBe(WORKFLOW_TYPES.fusion);
    expect(next.runId).not.toBe(oldRun.runId);
  });

  it('Temporal 连不上（真客户端连一个关着的端口）：WorkflowUnavailableError，不回 started', async () => {
    const connection = Connection.lazy({ address: `127.0.0.1:${await closedPort()}` });
    try {
      const client = new Client({ connection, namespace: 'default' });
      const requirements = createTemporalRequirementWorkflows(client, 'q', 3_000);
      await expect(requirements.start(requirementInput())).rejects.toBeInstanceOf(WorkflowUnavailableError);
    } finally {
      await connection.close();
    }
  });
});
