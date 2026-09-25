// 「你好」工作流：P0 验收（deploy/hello.sh）靠它证明引擎工人在接活。脚本和引擎各写各的名字，这里对上。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { DEFAULT_NAMESPACE, DEFAULT_TASK_QUEUE } from '../src/worker.ts';
import { useEnv, withWorker } from './helpers.ts';

const HELLO_SH = fileURLToPath(new URL('../../../deploy/hello.sh', import.meta.url));

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

describe('「你好」工作流', { timeout: 60_000 }, () => {
  it('跑一次回一句问候（hello.sh 传的就是一个 JSON 字符串）', async () => {
    const result = await withWorker(env, createFakeWorld(), async (q) =>
      env.client.workflow.execute(WORKFLOW_TYPES.hello, {
        taskQueue: q,
        workflowId: `hello-${Date.now()}`,
        args: ['法国'],
      }),
    );
    expect(result).toBe('你好，法国');
  });

  it('没给名字：明说失败（INVALID_INPUT，不重试），不回空话冒充跑通', async () => {
    const error = await withWorker(env, createFakeWorld(), async (q) =>
      env.client.workflow
        .execute(WORKFLOW_TYPES.hello, { taskQueue: q, workflowId: `hello-bad-${Date.now()}`, args: [''] })
        .catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe('INVALID_INPUT');
    expect((cause as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('deploy/hello.sh 里的工作流类型、任务队列、命名空间和引擎的对得上', () => {
    const script = readFileSync(HELLO_SH, 'utf8');
    const value = (name: string) => script.match(new RegExp(`^${name}=(\\S+)$`, 'm'))?.[1];
    expect({
      type: value('WORKFLOW_TYPE'),
      queue: value('TASK_QUEUE'),
      namespace: value('NAMESPACE'),
    }).toEqual({ type: WORKFLOW_TYPES.hello, queue: DEFAULT_TASK_QUEUE, namespace: DEFAULT_NAMESPACE });
  });
});
