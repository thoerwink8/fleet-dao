import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  update: vi.fn(),
  query: vi.fn(),
  signal: vi.fn(),
  checker: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('@temporalio/client', () => ({
  Connection: {
    connect: (...a: unknown[]) => {
      state.connect(...a);
      return {
        withAbortSignal: async (_s: unknown, fn: () => unknown) => fn(),
        withDeadline: async (_t: unknown, fn: () => unknown) => fn(),
        close: state.close,
      };
    },
  },
  Client: class {
    workflow = {
      getHandle: () => ({ executeUpdate: state.update, query: state.query, signal: state.signal }),
    };
  },
}));
vi.mock('../src/worker.ts', () => ({ configFromEnv: () => ({ address: 'isolated', namespace: 'test' }) }));
vi.mock('../src/real/index.ts', () => ({
  realPortsFromEnv: () => ({ checkPushHandback: state.checker, close: state.close }),
}));

import { runPermissionPushHandback } from '../src/bin/push-handback.ts';
import { type PushHandbackRequest, pushHandbackPayload } from '../src/push-handback.ts';

const run = '01a155b5-0f4b-7905-b9f7-8c82eb9e4bc9',
  identity = ['--workflow-id', 'task:acme/demo#3343', '--run-id', run];
let scratch: string;
beforeEach(async () => {
  vi.clearAllMocks();
  scratch = await mkdtemp(join(tmpdir(), 'fleet-handback-cli-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  state.checker.mockResolvedValue({ outcome: 'unknown', code: 'fixture' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});
describe('private permission-push CLI modes and retry inputs', () => {
  it('explicit H0/H1 check is read-only and does not print the server brief', async () => {
    state.checker.mockResolvedValue({
      outcome: 'natural-retired',
      head: 'a'.repeat(40),
      evidenceSha256: 'c'.repeat(64),
      brief: { request: 'private formal requirement', acceptance: ['private acceptance'] },
    });
    const flags = [
      '--original-contract-sha256',
      'a'.repeat(64),
      '--expected-contract-sha256',
      'b'.repeat(64),
    ];
    expect(await runPermissionPushHandback([...identity, ...flags])).toBe(0);
    expect(state.checker.mock.calls[0]?.[3]).toEqual({
      originalContract: { version: 1, sha256: 'a'.repeat(64) },
      expectedContract: { version: 1, sha256: 'b'.repeat(64) },
    });
    expect(state.update).not.toHaveBeenCalled();
    expect(state.signal).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toMatch(
      /private formal|private acceptance|brief/,
    );
  });
  it.each([
    ['--original-contract-sha256', 'a'.repeat(64)],
    ['--expected-contract-sha256', 'b'.repeat(64)],
    ['--original-contract-sha256', 'bad', '--expected-contract-sha256', 'b'.repeat(64)],
  ])('rejects partial or malformed contract identity before any source operation: %j', async (...flags) => {
    await expect(runPermissionPushHandback([...identity, ...flags])).rejects.toThrow(
      'invalid_contract_revision',
    );
    expect(state.checker).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
  });
  it('v2 retries exact H0/H1 and request after lost response; output distinguishes snapshot from control', async () => {
    const file = join(scratch, 'feedback-v2.txt');
    await writeFile(file, 'private revision feedback');
    let lost = true;
    state.update.mockImplementation(async (_name, options) => {
      const request = options.args[0] as PushHandbackRequest;
      if (lost) {
        lost = false;
        throw new Error('response lost after server consumption');
      }
      return {
        version: 2,
        requestId: request.requestId,
        payload: pushHandbackPayload(request),
        outcome: 'handed_back',
        acceptedContract: { version: 1, sha256: 'b'.repeat(64) },
      };
    });
    const args = [
      ...identity,
      '--execute',
      '--request-id',
      'fixed-v2',
      '--by',
      'private operator',
      '--feedback-file',
      file,
      '--original-contract-sha256',
      'a'.repeat(64),
      '--expected-contract-sha256',
      'b'.repeat(64),
    ];
    await expect(runPermissionPushHandback(args)).rejects.toThrow('response lost');
    expect(await runPermissionPushHandback(args)).toBe(0);
    expect(state.update.mock.calls[0]).toEqual(state.update.mock.calls[1]);
    const call = state.update.mock.calls[1]?.[1].args[0];
    expect(call.version).toBe(2);
    expect(call.originalContract.sha256).toBe('a'.repeat(64));
    expect(call.expectedContract.sha256).toBe('b'.repeat(64));
    const output = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(output).toContain('acceptedContract');
    expect(output).not.toMatch(/private operator|private revision|payload/);
    expect(state.query).not.toHaveBeenCalled();
    expect(state.signal).not.toHaveBeenCalled();
  });
  it.each([{ mode: [] }, { mode: ['--check'] }])(
    'default/check is truly query-only: $mode',
    async ({ mode }) => {
      expect(await runPermissionPushHandback([...identity, ...mode])).toBe(2);
      expect(state.checker).toHaveBeenCalledOnce();
      expect(state.update).not.toHaveBeenCalled();
      expect(state.signal).not.toHaveBeenCalled();
      expect(state.connect).not.toHaveBeenCalled();
    },
  );
  it('explicit execute can retry the identical request after a lost response even after hold query is gone', async () => {
    const file = join(scratch, 'feedback.txt');
    await writeFile(file, 'private exact feedback');
    let lost = true;
    const accepted = new Map<string, unknown>();
    state.update.mockImplementation(
      async (_name: string, opts: { updateId: string; args: Record<string, unknown>[] }) => {
        const r = opts.args[0]!;
        const receipt = accepted.get(opts.updateId) ?? {
          version: 1,
          requestId: r.requestId,
          payload: pushHandbackPayload(r as unknown as PushHandbackRequest),
          outcome: 'handed_back',
        };
        accepted.set(opts.updateId, receipt);
        if (lost) {
          lost = false;
          throw new Error('transport response lost');
        }
        return receipt;
      },
    );
    const args = [
      ...identity,
      '--execute',
      '--request-id',
      'retry1',
      '--by',
      'private operator',
      '--feedback-file',
      file,
    ];
    await expect(runPermissionPushHandback(args)).rejects.toThrow('transport response lost');
    expect(await runPermissionPushHandback(args)).toBe(0);
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(state.update.mock.calls[0]).toEqual(state.update.mock.calls[1]);
    expect(state.query).not.toHaveBeenCalled();
    expect(state.signal).not.toHaveBeenCalled();
    expect(accepted.size).toBe(1);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toMatch(
      /private exact feedback|private operator|payload/,
    );
  });
  it.each(
    [['--check', '--execute'], ['--request-id', 'x'], ['--execute'], ['--unknown', 'value']].map((extra) => ({
      extra,
    })),
  )('rejects invalid modes/flags before execute: $extra', async ({ extra }) => {
    await expect(runPermissionPushHandback([...identity, ...extra])).rejects.toThrow();
    expect(state.update).not.toHaveBeenCalled();
  });
});
