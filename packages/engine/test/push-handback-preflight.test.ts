import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushHandbackPreflightInput } from '../src/push-handback.ts';
import type { PushHandbackPreflightDeps } from '../src/real/push-handback-preflight.ts';

const state = vi.hoisted(() => ({
  input: null as PushHandbackPreflightInput | null,
  queries: 0,
  history: vi.fn(),
  retirement: vi.fn(),
  tree: vi.fn(),
  file: Buffer.alloc(0),
  info: {} as Record<string, unknown>,
  writes: vi.fn(),
  closed: vi.fn(),
}));
vi.mock('@temporalio/activity', () => ({ Context: { current: () => ({ info: state.info }) } }));
vi.mock('@temporalio/client', () => ({
  Connection: {
    connect: async () => ({
      withAbortSignal: async (_s: unknown, fn: () => unknown) => fn(),
      withDeadline: async (_d: unknown, fn: () => unknown) => fn(),
      close: state.closed,
    }),
  },
  Client: class {
    workflow = {
      getHandle: () => ({
        query: async () => {
          state.queries++;
          return structuredClone(state.input);
        },
        executeUpdate: state.writes,
        signal: state.writes,
      }),
    };
  },
}));
vi.mock('@fleet-dao/adapters', () => ({
  invokeTreeHelper: (...a: unknown[]) => state.retirement(...a),
  treeIdentity: (v: unknown) => v,
}));
vi.mock('../src/real/push-handback-history.ts', () => ({
  readNaturalPushHistory: (...a: unknown[]) => state.history(...a),
}));
vi.mock('../src/real/push-handback-tree.ts', () => ({
  readHandbackTree: (...a: unknown[]) => state.tree(...a),
}));
vi.mock('node:fs/promises', () => ({
  open: async (p: string) => ({
    fd: 7,
    close: async () => {},
    stat: async () => ({ isFile: () => p.endsWith('result.json'), size: state.file.length }),
    read: async (b: Buffer) => {
      state.file.copy(b);
      return { bytesRead: state.file.length };
    },
  }),
}));

import {
  createPushHandbackChecker,
  createPushHandbackPreflight,
} from '../src/real/push-handback-preflight.ts';

const run = '01a155b5-0f4b-7905-b9f7-8c82eb9e4bc9',
  session = '89b8928a-6a0c-4dfc-8ae7-0154a1644a94';
const input: PushHandbackPreflightInput = {
  version: 1,
  workflowId: 'task:acme/demo#3343',
  runId: run,
  task: {
    schemaVersion: 1,
    taskId: '9045a9dd-f458-44e9-be98-7be52974ed93',
    repo: { id: 'repo', owner: 'acme', name: 'demo', defaultBranch: 'main', testCommand: 'pnpm check' },
    issueNumber: 3343,
    title: 'handoff',
  },
  branch: 'fleet/3343-t01a155b5',
  path: '/var/lib/fleet-work/acme_demo/3343-t01a155b5',
  contract: { version: 1, sha256: 'c'.repeat(64) },
  token: { version: 1, runId: run, kind: 'parked', generation: 1, continued: 0 },
  budgetGrants: 1,
  taskTokenBudget: 1000,
  round: 1,
  verifyRound: 0,
};
const identity = { lex: input.path, real: input.path, dev: '1', ino: '2', uid: '1000' };
const ctx = () => ({
  signal: new AbortController().signal,
  attempt: 1,
  lastHeartbeat: undefined,
  heartbeat() {},
});
function deps(): PushHandbackPreflightDeps {
  const startedAt = new Date(Date.now() - 4000),
    endedAt = new Date(Date.now() - 3000);
  state.file = Buffer.from(
    JSON.stringify({
      runId: session,
      outcome: 'done',
      exitCode: 0,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
    }),
  );
  return {
    address: 'isolated',
    namespace: 'test',
    taskQueue: 'fleet',
    runsDir: '/trusted/runs',
    exec: vi.fn(),
    trees: {
      treeFor: () => input.path,
      ownerOf: async () => 'fleet-test',
    } as unknown as PushHandbackPreflightDeps['trees'],
    getRun: async () =>
      ({
        id: session,
        taskId: input.task.taskId,
        issueNumber: 3343,
        workflowId: input.workflowId,
        temporalRunId: null,
        branch: input.branch,
        worktreePath: input.path,
        outcome: 'done',
        startedAt,
        endedAt,
        sessionId: 'session',
      }) as never,
    openRuns: async () => 0,
    spend: async () => ({ tokens: 10, estimated: 0, runs: 1, unmetered: 0 }),
    brief: async () => ({ ok: true, brief: { contract: input.contract } }) as never,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.input = structuredClone(input);
  state.queries = 0;
  state.info = {
    isLocal: false,
    activityType: 'readPushHandbackPreflight',
    attempt: 1,
    workflowNamespace: 'test',
    taskQueue: 'fleet',
    workflowExecution: { workflowId: input.workflowId, runId: run },
    activityId: 'current',
  };
  state.history.mockImplementation(async () => ({
    worker: '4864@fixture',
    runIds: [session],
    sinceMs: Date.now() - 5000,
    failedHead: 'a'.repeat(40),
    sha256: 'd'.repeat(64),
  }));
  state.tree.mockImplementation(async () => ({
    identity,
    head: 'a'.repeat(40),
    fingerprint: 'same-metadata',
  }));
  state.retirement.mockImplementation(async () => ({
    state: 'natural-retired',
    identity,
    worker: '4864@fixture',
    runIds: [session],
    failed: 0,
    scanned: 10,
    bootId: 'a'.repeat(32),
    invocationId: 'b'.repeat(32),
    helperCount: 2,
    engineStoppedUs: String((Date.now() - 1000) * 1000),
    scopes: [
      {
        id: session,
        startedUs: String((Date.now() - 4000) * 1000),
        endedUs: String((Date.now() - 2000) * 1000),
      },
    ],
  }));
});
describe('trusted reader assembly; source IO mocks, full observation policy runs', () => {
  it('checker performs only two queries and reads, never Update or signal; no current activity history required', async () => {
    const result = await createPushHandbackChecker(deps())(input.workflowId, run, ctx().signal);
    expect(result).toMatchObject({ outcome: 'natural-retired', head: 'a'.repeat(40) });
    expect(state.queries).toBe(2);
    expect(state.writes).not.toHaveBeenCalled();
    expect(state.history.mock.calls[0]?.[3]).toBeUndefined();
    expect(state.closed).toHaveBeenCalled();
  });
  it('execute Activity binds attempt, queue, workflow/run and re-reads every trusted source', async () => {
    const d = deps();
    expect((await createPushHandbackPreflight(d)(input, ctx())).outcome).toBe('natural-retired');
    expect(state.history.mock.calls[0]?.[3]).toBe('current');
    expect(state.tree).toHaveBeenCalledTimes(2);
    expect(state.retirement).toHaveBeenCalledTimes(1);
    state.info.attempt = 2;
    expect(await createPushHandbackPreflight(d)(input, ctx())).toEqual({
      outcome: 'unknown',
      code: 'activity_identity',
    });
    expect(state.retirement).toHaveBeenCalledTimes(1);
  });
  it.each([
    'scope-missing',
    'scope-duplicate',
    'scope-reversed',
    'bad-time',
    'helper-count',
    'tree-changed',
    'contract-changed',
    'active-run',
    'metering-unknown',
  ] as const)('refuses %s without granting handback', async (kind) => {
    const d = deps(),
      original = state.retirement.getMockImplementation()!;
    state.retirement.mockImplementation(async (...a: unknown[]) => {
      const r = await original(...a);
      if (kind === 'scope-missing') r.scopes[0].id = 'foreign';
      if (kind === 'scope-duplicate') r.scopes.push({ ...r.scopes[0] });
      if (kind === 'scope-reversed') r.scopes[0].endedUs = r.scopes[0].startedUs.slice(0, -2);
      if (kind === 'bad-time') r.engineStoppedUs = 'bad';
      if (kind === 'helper-count') r.helperCount = 0;
      return r;
    });
    if (kind === 'tree-changed')
      state.tree
        .mockResolvedValueOnce({ identity, head: 'a'.repeat(40), fingerprint: 'before' })
        .mockResolvedValueOnce({ identity, head: 'a'.repeat(40), fingerprint: 'after' });
    if (kind === 'contract-changed')
      d.brief = async () =>
        ({ ok: true, brief: { contract: { version: 1, sha256: 'f'.repeat(64) } } }) as never;
    if (kind === 'active-run') d.openRuns = async () => 1;
    if (kind === 'metering-unknown')
      d.spend = async () => ({ tokens: 0, estimated: 0, runs: 1, unmetered: 1 });
    expect((await createPushHandbackPreflight(d)(input, ctx())).outcome).toBe('unknown');
  });
  it('cancellation returns unknown even if a DB reader never resolves', async () => {
    const d = deps(),
      control = new AbortController();
    d.getRun = async () => new Promise(() => {});
    const result = createPushHandbackPreflight(d)(input, { ...ctx(), signal: control.signal });
    await vi.waitFor(() => expect(state.history).toHaveBeenCalled());
    control.abort();
    expect(await result).toMatchObject({ outcome: 'unknown', code: 'cancelled' });
  });
});
