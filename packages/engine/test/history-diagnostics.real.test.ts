// 独立合成夹具验证真实 SDK/RPC/原 protobuf；不更改原业务用例的时间和断言。
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
import { expect, it } from 'vitest';
import { createFakeWorld } from '../src/fakes.ts';
import { createRealEnv, engineBundle, withWorker } from './helpers.ts';
import {
  DiagnosticOutput,
  decodeFrames,
  PREFIX,
  SyntheticHistoryDiagnostics,
} from './history-diagnostics.ts';

it.each(['watchdog', 'early-failure'] as const)(
  'captures an exact real run at %s and restores original protobuf before manual teardown',
  async (mode) => {
    const env = await createRealEnv();
    const lines: string[] = [];
    let captured!: () => void;
    const observation = new Promise<void>((resolve) => {
      captured = resolve;
    });
    let scope: SyntheticHistoryDiagnostics | undefined;
    let handle: WorkflowHandleWithFirstExecutionRunId | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let fireWatchdog: (() => void) | undefined;
    let watchdogCancelled = false;
    const originalFailure = new Error('bounded synthetic early assertion');
    try {
      await engineBundle();
      scope = new SyntheticHistoryDiagnostics({
        test: `bounded real synthetic diagnostic ${mode}`,
        testSha256: createHash('sha256')
          .update(readFileSync(new URL(import.meta.url)))
          .digest('hex'),
        failed: () => false,
        scheduleWatchdog: (onFire, delayMs) => {
          expect(delayMs).toBe(50_000);
          fireWatchdog = onFire;
          return () => {
            fireWatchdog = undefined;
            watchdogCancelled = true;
          };
        },
        output: new DiagnosticOutput((line) => {
          lines.push(line);
          console.error(line);
          if (line.includes('"outcome":"captured"') && line.includes('"kind":"history"')) captured();
        }),
      });
      const current = scope;
      const operation = current.track(
        withWorker(
          env,
          createFakeWorld(),
          async (taskQueue) => {
            handle = await current.start(env, 'helloWorkflow', {
              workflowId: `synthetic-diagnostic-${randomUUID()}`,
              taskQueue,
              args: ['isolated fixture'],
            });
            expect(await handle.result()).toBe('你好，isolated fixture');
            if (mode === 'early-failure') throw originalFailure;
            current.mark('bounded-host-wait-after-real-result');
            expect(lines).toEqual([]);
            if (!fireWatchdog) throw new Error('controlled watchdog unavailable');
            fireWatchdog();
            await Promise.race([
              observation,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('real capture not observed')), 6000);
              }),
            ]);
            clearTimeout(timeout);
          },
          { observeWorker: (worker, run, bundle) => current.worker(env, worker, run, bundle) },
        ),
      );
      if (mode === 'early-failure') await expect(operation).rejects.toBe(originalFailure);
      else await operation;
      if (!handle) throw new Error('exact synthetic handle unavailable');
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
      expect(
        lines.some((line) =>
          line.includes(mode === 'watchdog' ? 'bounded-host-wait-after-real-result' : 'test-body-failed'),
        ),
      ).toBe(true);
    } catch (error) {
      await scope?.captureFailure();
      throw error;
    } finally {
      clearTimeout(timeout);
      if (scope) {
        await scope.finish();
        expect(watchdogCancelled).toBe(true);
        expect(fireWatchdog).toBeUndefined();
      } else await env.teardown();
    }
  },
  20_000,
);
