// 后端拉起需求工作流（@fleet-dao/api 的 createTemporalRequirementWorkflows）对着真的 Temporal 测试服务端和真的引擎工作流：
// 类型名、输入形状两边对得上（引擎真跑完），同一张 issue 在跑时不起第二条，结束后能再起，连不上明确失败。
import { createServer } from 'node:net';
import { createTemporalRequirementWorkflows, WorkflowUnavailableError } from '@fleet-dao/api';
import { Client, Connection } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { type RequirementResult, requirementWorkflowId } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { requirementInput, useEnv, withWorker } from './helpers.ts';

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

describe('后端拉起需求工作流（真 Temporal 测试服务端）', { timeout: 60_000 }, () => {
  it('起得来、引擎真跑完；在跑时同一张 issue 再起回 already_running；结束后（重开）能再起', async () => {
    const taskQueue = `q-start-${Date.now()}`;
    const requirements = createTemporalRequirementWorkflows(env.client, taskQueue);
    const input = requirementInput();
    const workflowId = requirementWorkflowId(input.repo, input.issueNumber);

    // 还没有工人：工作流起来了、一直在跑，第二次（重投、重放）必然撞上
    expect(await requirements.start(input)).toBe('started');
    expect(await requirements.start({ ...input, taskId: 'another-task' })).toBe('already_running');
    expect((await env.client.workflow.getHandle(workflowId).describe()).status.name).toBe('RUNNING');

    const world = createFakeWorld({ plan: [{ key: 'readme', title: '改说明', touches: ['docs'] }] });
    const result = await withWorker(
      env,
      world,
      async () => (await env.client.workflow.getHandle(workflowId).result()) as RequirementResult,
      { taskQueue },
    );
    expect(result.state).toBe('done');
    // 引擎收到的输入就是后端给的那份（后端没带的可选项用引擎默认）
    expect(world.states.at(-1)?.taskId).toBe(input.taskId);

    expect(await requirements.start(input)).toBe('started');
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
