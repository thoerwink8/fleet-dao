import { describe, expect, it, vi } from 'vitest';
import { type PushHandbackRequest, pushHandbackPayload } from '../src/push-handback.ts';
import { requestPushHandback } from '../src/push-handback-client.ts';

const originalContract = { version: 1 as const, sha256: 'a'.repeat(64) };
const expectedContract = { version: 1 as const, sha256: 'b'.repeat(64) };
const base = {
  requestId: 'fixed-request',
  token: {
    version: 1 as const,
    runId: '01a155b5-0f4b-7905-b9f7-8c82eb9e4bc9',
    kind: 'parked' as const,
    generation: 1,
    continued: 0,
  },
  by: 'synthetic operator',
  feedback: 'synthetic feedback',
};
const request: PushHandbackRequest = { version: 2, ...base, originalContract, expectedContract };

describe('handback versioned exact payload and receipt', () => {
  it('v1 wire payload is unchanged and extra contract fields cannot silently opt it into revision', () => {
    expect(pushHandbackPayload({ version: 1, ...base })).toBe(JSON.stringify({ version: 1, ...base }));
    expect(() =>
      pushHandbackPayload({ version: 1, ...base, expectedContract } as PushHandbackRequest),
    ).toThrow();
    expect(JSON.parse(pushHandbackPayload(request))).toEqual(request);
  });
  it.each(['originalContract', 'expectedContract'] as const)(
    'validates exact %s rather than accepting arbitrary caller brief or metadata',
    (field) => {
      for (const value of [
        undefined,
        null,
        { version: 1, sha256: 'bad' },
        { version: 2, sha256: 'c'.repeat(64) },
        { ...expectedContract, brief: 'caller supplied' },
      ]) {
        expect(() => pushHandbackPayload({ ...request, [field]: value })).toThrow();
      }
    },
  );
  it('changed H0/H1 changes transport identity; lost response can be retried with identical identity', async () => {
    const update = vi.fn(async (_name, options) => ({
      version: 2 as const,
      requestId: request.requestId,
      payload: pushHandbackPayload(options.args[0]),
      outcome: 'unknown' as const,
      code: 'contract',
    }));
    const handle = { executeUpdate: update } as unknown as Parameters<typeof requestPushHandback>[0];
    await requestPushHandback(handle, request);
    await requestPushHandback(handle, request);
    expect(update.mock.calls[0]).toEqual(update.mock.calls[1]);
    await requestPushHandback(handle, { ...request, expectedContract: originalContract });
    expect(update.mock.calls[2]?.[1].updateId).not.toBe(update.mock.calls[0]?.[1].updateId);
  });
  it.each([undefined, originalContract])(
    'v2 handed_back with missing or wrong accepted snapshot is rejected: %j',
    async (acceptedContract) => {
      const handle = {
        executeUpdate: async () => ({
          version: 2,
          requestId: request.requestId,
          payload: pushHandbackPayload(request),
          outcome: 'handed_back',
          acceptedContract,
        }),
      } as unknown as Parameters<typeof requestPushHandback>[0];
      await expect(requestPushHandback(handle, request)).rejects.toThrow('PUSH_HANDBACK_RECEIPT_MISMATCH');
    },
  );
});
