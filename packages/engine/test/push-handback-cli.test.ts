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
