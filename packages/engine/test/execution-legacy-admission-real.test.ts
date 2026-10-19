import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalExecutionInput, createMemoryStore } from '@fleet-dao/store';
import { Connection } from '@temporalio/client';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { expect, it } from 'vitest';
import { createLegacyExecutionAdmission } from '../src/real/execution-legacy-admission.ts';
import { EXECUTION_HISTORY_MAX_BYTES } from '../src/real/execution-start-reader.ts';
import { createRealEnv } from './support.ts';

it('真实服务：无参 Local Activity 从实际 Start 准入；同 run 幂等、不同代次并存、managed 字段不降格', async () => {
  const bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('./fixtures/execution-legacy-probe.ts', import.meta.url)),
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, log() {} } as never,
  });
  const env = await createRealEnv();
  let connection: Connection | undefined;
  try {
    const namespace = env.namespace ?? 'default';
    const taskQueue = `legacy-admission-${randomUUID()}`;
    const taskId = randomUUID();
    const repo = {
      id: randomUUID(),
      owner: 'example',
      name: 'canary',
      defaultBranch: 'main',
      testCommand: 'pnpm check',
    };
    const input = {
      schemaVersion: 1,
      taskId,
      repo,
      issueNumber: 12,
      title: '  原始标题\n',
      extra: { body: '  private Start\n', values: [2, 1, null] },
    };
    const store = createMemoryStore({
      repos: [{ ...repo, owner: 'renamed', name: 'current' }],
      tasks: [
        {
          id: taskId,
          repoId: repo.id,
          issueNumber: 12,
          title: '当前标题',
          rawRequest: '',
          requestedBy: 'test',
          state: 'queued',
          priority: 0,
          createdAt: '2026-10-20T00:00:00.000Z',
        },
      ],
    });
    connection = await Connection.connect({
      address: env.address,
      interceptors: [],
      channelArgs: { 'grpc.max_receive_message_length': EXECUTION_HISTORY_MAX_BYTES },
    });
    const adapter = createLegacyExecutionAdmission({
      namespace,
      taskQueue,
      connection,
      store,
      audit: { actor: { kind: 'user', id: randomUUID() }, via: 'agent', reason: '真实 legacy 来源隔离验证' },
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace,
      taskQueue,
      workflowBundle: bundle,
      shutdownGraceTime: '1s',
      activities: { decide: adapter },
    });
    await worker.runUntil(async () => {
      for (const generation of [1, 2]) {
        const workflowId = `task:example/canary#12${generation === 1 ? '' : ':r2'}`;
        const handle = await env.client.workflow.start('taskWorkflow', {
          workflowId,
          taskQueue,
          args: [input],
        });
        const results = await handle.result();
        expect(results).toEqual([
          { kind: 'allowed', status: 'admitted', admissionId: expect.any(String), postCommitWarnings: [] },
          { kind: 'allowed', status: 'replayed', admissionId: expect.any(String), postCommitWarnings: [] },
        ]);
        expect(results[0].admissionId).toBe(results[1].admissionId);
        const stored = [...store.data.legacyExecutionAdmissions.values()].find(
          (a) => a.runId === handle.firstExecutionRunId,
        );
        expect(stored).toMatchObject({
          taskId,
          namespace,
          workflowId,
          runId: handle.firstExecutionRunId,
          taskQueue,
          workflowType: 'taskWorkflow',
          generation,
          inputCanonical: canonicalExecutionInput(input),
        });
      }
      expect(store.data.legacyExecutionAdmissions.size).toBe(2);
      expect(store.data.audit).toHaveLength(2);
      const unsupported = await env.client.workflow.execute('taskWorkflow', {
        workflowId: 'task:example/canary#12:r3',
        taskQueue,
        args: [{ ...input, execution: null }],
      });
      expect(unsupported).toEqual([
        { kind: 'denied', code: 'managed_start_unsupported' },
        { kind: 'denied', code: 'managed_start_unsupported' },
      ]);
      expect(store.data.legacyExecutionAdmissions.size).toBe(2);
      expect(store.data.audit).toHaveLength(2);
      expect(JSON.stringify(store.data.audit)).not.toContain('private Start');
    });
  } finally {
    await connection?.close();
    await env.teardown();
  }
}, 180_000);
