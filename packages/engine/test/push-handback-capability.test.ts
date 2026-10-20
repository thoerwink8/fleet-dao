import { describe, expect, it, vi } from 'vitest';
import { type PushHandbackRequest, pushHandbackPayload } from '../src/push-handback.ts';

vi.mock('@temporalio/workflow', async (original) => ({
  ...(await original<typeof import('@temporalio/workflow')>()),
  patched: () => true,
  condition: async () => {},
  workflowInfo: () => ({ runId: '01a155b5-0f4b-7905-b9f7-8c82eb9e4bc9' }),
}));

import { TaskRuntime } from '../src/workflows/task-runtime.ts';

describe('v2 old workflow contract-boundary capability', () => {
  it('new worker code cannot grant v2 when the reconstructed old execution never enabled contract revisions', async () => {
    // Exercise the real handler's earliest capability gate without manufacturing a historical patch.
    const runtime = Object.create(TaskRuntime.prototype) as TaskRuntime;
    runtime.contractVersioned = false;
    runtime.acceptHandbackContract = vi.fn();
    const preflight = vi.fn();
    Object.assign(runtime, {
      acts: { readPushHandbackPreflight: preflight },
      pushHandback: null,
      pushHandbackRequests: new Map(),
      pushHoldMatches: () => true,
    });
    const request: PushHandbackRequest = {
      version: 2,
      requestId: 'unsupported-old',
      token: {
        version: 1,
        kind: 'parked',
        runId: '01a155b5-0f4b-7905-b9f7-8c82eb9e4bc9',
        generation: 1,
        continued: 0,
      },
      by: 'test',
      feedback: 'rework',
      originalContract: { version: 1, sha256: 'a'.repeat(64) },
      expectedContract: { version: 1, sha256: 'b'.repeat(64) },
    };
    const handler = runtime as unknown as {
      handlePushHandback(r: PushHandbackRequest, payload: string): Promise<unknown>;
    };
    expect(await handler.handlePushHandback(request, pushHandbackPayload(request))).toMatchObject({
      version: 2,
      outcome: 'unknown',
      code: 'unsupported_contract_boundary',
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(runtime.acceptHandbackContract).not.toHaveBeenCalled();
  });
});
