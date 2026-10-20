// 独立合成夹具验证真实 SDK/RPC/原 protobuf；不更改原业务用例的时间和断言。
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createFakeWorld } from '../src/fakes.ts';
import { createRealEnv, withWorker } from './helpers.ts';
import {
  DiagnosticOutput,
  decodeFrames,
  PREFIX,
  SyntheticHistoryDiagnostics,
} from './history-diagnostics.ts';

it('captures an exact real run during a bounded synthetic host wait and restores its original protobuf', async () => {
  const env = await createRealEnv();
  const lines: string[] = [];
  let captured!: () => void;
  const observation = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let scope: SyntheticHistoryDiagnostics | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await withWorker(
      env,
      createFakeWorld(),
      async (taskQueue) => {
        scope = new SyntheticHistoryDiagnostics({
          test: 'bounded real synthetic diagnostic',
          testSha256: createHash('sha256')
            .update(readFileSync(new URL(import.meta.url)))
            .digest('hex'),
          failed: () => false,
          watchdogMs: 1000,
          output: new DiagnosticOutput((line) => {
            lines.push(line);
            console.error(line);
            if (line.includes('"outcome":"captured"') && line.includes('"kind":"history"')) captured();
          }),
        });
        const handle = await scope.start(env, 'helloWorkflow', {
          workflowId: `synthetic-diagnostic-${randomUUID()}`,
          taskQueue,
          args: ['isolated fixture'],
        });
        expect(await handle.result()).toBe('你好，isolated fixture');
        scope.mark('bounded-host-wait-after-real-result');
        await Promise.race([
          observation,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('real capture not observed')), 6000);
          }),
        ]);
        clearTimeout(timeout);
        const exact = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
        const original = await env.client.connection.withDeadline(Date.now() + 3000, () =>
          exact.fetchHistory(),
        );
        const encoder = original.constructor as unknown as {
          encode(message: unknown): { finish(): Uint8Array };
        };
        const frames = lines.filter((line) => JSON.parse(line.slice(PREFIX.length)).type !== 'status');
        const end = frames.findIndex((line) => JSON.parse(line.slice(PREFIX.length)).type === 'end');
        const decoded = decodeFrames(frames.slice(0, end + 1));
        expect(decoded.bytes).toEqual(Buffer.from(encoder.encode(original).finish()));
        expect(decoded.identity.workflowId).toBe(handle.workflowId);
        expect(decoded.identity.runId).toBe(handle.firstExecutionRunId);
        expect(decoded.identity.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(lines.some((line) => line.includes('bounded-host-wait-after-real-result'))).toBe(true);
      },
      {
        observeWorker: (worker, run, bundle) => {
          if (!scope) throw new Error('synthetic diagnostic scope not created');
          scope.worker(env, worker, run, bundle);
        },
      },
    );
  } finally {
    clearTimeout(timeout);
    if (scope) await scope.finish();
    else await env.teardown();
  }
}, 20_000);
