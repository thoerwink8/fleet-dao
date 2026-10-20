import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { activityInfo, Context } from '@temporalio/activity';
import { Connection } from '@temporalio/client';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { expect, it } from 'vitest';
import {
  EXECUTION_HISTORY_MAX_BYTES,
  type ExecutionStartRead,
  executionStartReader,
  type ObservedExecution,
} from '../src/real/execution-start-reader.ts';
import { createRealEnv } from './support.ts';

it('真实服务：Local ActivityInfo 对应精确 Start；相同 workflowId 的新旧 run 不串输入，实际接收超限明确拒绝', async () => {
  const bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('./fixtures/execution-start-probe.ts', import.meta.url)),
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, log() {} } as never,
  });
  const env = await createRealEnv();
  let connection: Connection | undefined;
  let smallConnection: Connection | undefined;
  try {
    connection = await Connection.connect({
      address: env.address,
      interceptors: [],
      channelArgs: { 'grpc.max_receive_message_length': EXECUTION_HISTORY_MAX_BYTES },
    });
    const reader = executionStartReader(connection);
    const observed: ObservedExecution[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace ?? 'default',
      taskQueue: `start-evidence-${randomUUID()}`,
      workflowBundle: bundle,
      shutdownGraceTime: '1s',
      activities: {
        observeStart: async (): Promise<ExecutionStartRead> => {
          const info = activityInfo();
          if (!info.workflowExecution || !info.workflowNamespace || !info.workflowType || !info.isLocal)
            throw new Error('真实 Local ActivityInfo 缺少执行身份');
          const current: ObservedExecution = {
            namespace: info.workflowNamespace,
            workflowId: info.workflowExecution.workflowId,
            runId: info.workflowExecution.runId,
            workflowType: info.workflowType,
            taskQueue: info.taskQueue,
            isLocal: true,
          };
          observed.push(current);
          return reader.read(current, Context.current().cancellationSignal);
        },
      },
    });
    await worker.runUntil(async () => {
      const workflowId = `start-evidence-${randomUUID()}`;
      const firstInput = { taskId: 'task-1', opId: 'first-operation', text: '  原始输入\n' };
      const first = await env.client.workflow.start('executionStartProbe', {
        workflowId,
        taskQueue: worker.options.taskQueue,
        args: [firstInput],
      });
      expect(await first.result()).toEqual({
        kind: 'observed',
        observed: observed[0],
        startEventId: '1',
        input: firstInput,
      });
      expect(observed[0]?.runId).toBe(first.firstExecutionRunId);
      const secondInput = { taskId: 'task-1', opId: 'second-operation', text: 'x'.repeat(16 * 1024) };
      const second = await env.client.workflow.start('executionStartProbe', {
        workflowId,
        taskQueue: worker.options.taskQueue,
        args: [secondInput],
      });
      expect(await second.result()).toEqual({
        kind: 'observed',
        observed: observed[1],
        startEventId: '1',
        input: secondInput,
      });
      expect(observed[1]?.runId).toBe(second.firstExecutionRunId);
      expect(observed[1]?.runId).not.toBe(observed[0]?.runId);
      const [firstObserved, secondObserved] = observed;
      if (!firstObserved || !secondObserved) throw new Error('缺少两次真实活动观测');
      const signal = new AbortController().signal;
      await expect(reader.read(firstObserved, signal)).resolves.toMatchObject({
        kind: 'observed',
        input: firstInput,
      });
      await expect(reader.read(secondObserved, signal)).resolves.toMatchObject({
        kind: 'observed',
        input: secondInput,
      });
      await expect(reader.read({ ...firstObserved, runId: randomUUID() }, signal)).resolves.toEqual({
        kind: 'unknown',
        code: 'not_found',
      });
      smallConnection = await Connection.connect({
        address: env.address,
        // SDK 默认重试 RESOURCE_EXHAUSTED；此专用只读连接保留首个真实大小错误。
        interceptors: [],
        channelArgs: { 'grpc.max_receive_message_length': 4_096 },
      });
      await expect(executionStartReader(smallConnection).read(secondObserved, signal)).resolves.toEqual({
        kind: 'unknown',
        code: 'limit',
      });
    });
  } finally {
    await smallConnection?.close();
    await connection?.close();
    await env.teardown();
  }
}, 180_000);
