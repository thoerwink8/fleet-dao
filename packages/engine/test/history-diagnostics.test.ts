import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import type { Worker, WorkflowBundle } from '@temporalio/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiagnosticOutput,
  decodeFrames,
  encodeFrames,
  HISTORY_LIMIT,
  OUTPUT_LIMIT,
  PREFIX,
  SyntheticHistoryDiagnostics,
} from './history-diagnostics.ts';

const identity = {
  test: 'synthetic',
  workflowId: 'workflow',
  runId: 'exact-run',
  bundleSha256: 'a'.repeat(64),
  testSha256: 'b'.repeat(64),
  ciSha: 'unknown',
};
const roots: string[] = [];
const realImmediate = globalThis.setImmediate;
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const parse = (line: string) => JSON.parse(line.slice(PREFIX.length));
const serialize = (frame: unknown) => `${PREFIX}${JSON.stringify(frame)}`;

describe('bounded original history transport', () => {
  it('restores original arbitrary bytes and exact identity without JSON payload conversion', () => {
    const bytes = randomBytes(120_000);
    const restored = decodeFrames(encodeFrames('history', identity, bytes));
    expect(restored).toEqual({ identity, kind: 'history', bytes });
  });
  it.each(['missing-end', 'missing-chunk', 'duplicate', 'mixed-id', 'reordered', 'digest', 'bytes', 'kind'])(
    'rejects %s instead of exposing an apparently complete history',
    (failure) => {
      const frames = encodeFrames('history', identity, randomBytes(40_000)).map(parse);
      if (failure === 'missing-end') frames.pop();
      if (failure === 'missing-chunk') frames.splice(1, 1);
      if (failure === 'duplicate') frames.splice(1, 0, frames[1]);
      if (failure === 'mixed-id') frames[1].id = 'other';
      if (failure === 'reordered') [frames[1], frames[2]] = [frames[2], frames[1]];
      if (failure === 'digest') frames[0].sha256 = frames.at(-1).sha256 = '0'.repeat(64);
      if (failure === 'bytes') frames[0].bytes--;
      if (failure === 'kind') frames[0].kind = 'unknown';
      expect(() => decodeFrames(frames.map(serialize))).toThrow();
    },
  );
  it('rejects oversized capture and gzip expansion before returning bytes', () => {
    expect(() => encodeFrames('history', identity, Buffer.alloc(HISTORY_LIMIT + 1))).toThrow('byte-limit');
    const frames = encodeFrames('history', identity, Buffer.alloc(HISTORY_LIMIT)).map(parse);
    frames[0].kind = 'describe';
    frames[0].bytes = 1;
    expect(() => decodeFrames(frames.map(serialize))).toThrow();
  });
  it('reserves unknown-status capacity and never emits partial frame groups after file budget exhaustion', () => {
    const lines: string[] = [];
    const output = new DiagnosticOutput((line) => lines.push(line));
    const frames = encodeFrames('history', identity, randomBytes(HISTORY_LIMIT));
    output.frames(frames);
    output.frames(frames);
    const before = lines.length;
    expect(() => output.frames(frames)).toThrow('file-output-limit');
    expect(lines).toHaveLength(before);
    output.status({ outcome: 'unknown', code: 'file-output-limit' });
    expect(lines.map(parse).at(-1)).toMatchObject({ outcome: 'unknown', code: 'file-output-limit' });
    expect(lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)).toBeLessThanOrEqual(
      OUTPUT_LIMIT,
    );
  });
});

async function fixture(
  failed = false,
  started = true,
  emit?: (line: string) => void,
  scheduleWatchdog?: (onFire: () => void, delayMs: number) => () => void,
) {
  const root = await mkdtemp(join(tmpdir(), 'fleet-synthetic-history-'));
  roots.push(root);
  const lines: string[] = [],
    order: string[] = [];
  const raw = randomBytes(1024);
  class History {
    readonly synthetic = true;
    static encode() {
      return { finish: () => raw };
    }
  }
  const exactHandle = {
    fetchHistory: vi.fn(async () => new History()),
    describe: vi.fn(async () => ({
      workflowId: 'workflow',
      runId: 'exact-run',
      status: { name: 'RUNNING', code: 1 },
      historyLength: 18,
      raw: { pendingActivities: [], memo: { secret: 'must not appear in describe' } },
    })),
  };
  const withDeadline = vi.fn(async (_deadline: number, fn: () => Promise<unknown>) => fn());
  const env = {
    client: {
      connection: { withDeadline },
      workflow: {
        start: vi.fn(async () => ({ workflowId: 'workflow', firstExecutionRunId: 'exact-run' })),
        getHandle: vi.fn(() => exactHandle),
      },
    },
    teardown: vi.fn(async () => {
      order.push('teardown');
    }),
  } as unknown as TestWorkflowEnvironment;
  const scope = new SyntheticHistoryDiagnostics({
    test: 'synthetic',
    testSha256: identity.testSha256,
    output: new DiagnosticOutput((line) => {
      lines.push(line);
      emit?.(line);
    }),
    failed: () => failed,
    artifactRoot: root,
    ...(scheduleWatchdog ? { scheduleWatchdog } : {}),
  });
  let state = 'RUNNING';
  let resolve!: () => void;
  const run = new Promise<void>((r) => {
    resolve = r;
  });
  const worker = {
    getState: () => state,
    shutdown: vi.fn(() => {
      order.push('shutdown');
      state = 'STOPPING';
    }),
  } as unknown as Worker;
  const stop = () => {
    state = 'STOPPED';
    order.push('worker-run-settled');
    resolve();
  };
  scope.environment(env);
  scope.worker(env, worker, run, { code: 'actual synthetic bundle' } as WorkflowBundle);
  scope.track(run);
  if (started) await scope.start(env, 'taskWorkflow', { workflowId: 'workflow', taskQueue: 'q', args: [] });
  return { scope, env, worker, run, stop, lines, exactHandle, withDeadline, root, raw, order };
}

describe('local watchdog and owned worker cleanup', () => {
  it('defers a controlled watchdog until slow preparation and the exact-run host barrier are ready', async () => {
    vi.useFakeTimers();
    let fire!: () => void;
    const cancel = vi.fn();
    const schedule = vi.fn((onFire: () => void, _delayMs: number) => {
      fire = onFire;
      return cancel;
    });
    const f = await fixture(false, false, undefined, schedule);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 50_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.lines).toEqual([]);
    expect(f.exactHandle.fetchHistory).not.toHaveBeenCalled();
    await f.scope.start(f.env, 'taskWorkflow', { workflowId: 'workflow', taskQueue: 'q', args: [] });
    f.scope.mark('bounded-host-wait-after-real-result');
    fire();
    await f.scope.captureFailure();
    expect(f.lines.map(parse)).toContainEqual(
      expect.objectContaining({
        outcome: 'captured',
        kind: 'history',
        reason: 'watchdog',
        stage: 'bounded-host-wait-after-real-result',
        runId: 'exact-run',
      }),
    );
    expect(f.exactHandle.fetchHistory).toHaveBeenCalledTimes(1);
    expect(f.worker.shutdown).not.toHaveBeenCalled();
    f.stop();
    await f.scope.finish();
    await f.scope.finish();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('cancels an unfired controlled watchdog exactly once without capture', async () => {
    const cancel = vi.fn();
    const f = await fixture(false, true, undefined, () => cancel);
    f.stop();
    await f.scope.finish();
    await f.scope.finish();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.exactHandle.fetchHistory).not.toHaveBeenCalled();
    expect(f.lines).toEqual([]);
  });
  it('keeps an intentionally early controlled watchdog explicitly unknown without inventing a run', async () => {
    let fire!: () => void;
    const f = await fixture(false, false, undefined, (onFire) => {
      fire = onFire;
      return () => undefined;
    });
    fire();
    await f.scope.captureFailure();
    f.stop();
    await f.scope.finish();
    expect(f.lines.map(parse)).toEqual([
      expect.objectContaining({ reason: 'watchdog', stage: 'test-start', code: 'no-started-run' }),
    ]);
    expect(f.exactHandle.fetchHistory).not.toHaveBeenCalled();
  });
  it('does not replace the original error when diagnostic output itself fails', async () => {
    const original = new Error('original assertion');
    const sink = new Error('diagnostic output unavailable');
    const f = await fixture(false, true, () => {
      throw sink;
    });
    await expect(f.scope.track(Promise.reject(original))).rejects.toBe(original);
    const finishing = f.scope.finish();
    void finishing.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.worker.shutdown).toHaveBeenCalledTimes(1);
    expect(f.env.teardown).not.toHaveBeenCalled();
    f.stop();
    await expect(finishing).rejects.toBe(sink);
    await f.scope.closeEnvironment(f.env);
    expect(f.env.teardown).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(['shutdown', 'worker-run-settled', 'teardown']);
  });
  it('consumes watchdog output rejection but retains it for finish after closing owned resources', async () => {
    vi.useFakeTimers();
    const sink = new Error('watchdog sink unavailable');
    let finalSink!: () => void;
    const finalStatus = new Promise<void>((resolve) => {
      finalSink = resolve;
    });
    const f = await fixture(false, true, (line) => {
      if (parse(line).code === 'capture-failed') finalSink();
      throw sink;
    });
    await vi.advanceTimersByTimeAsync(50_000);
    await finalStatus;
    // 在用户读取 capturePromise 之前过一轮真实事件循环；未消费的 watchdog 拒绝会被 Vitest 报出。
    await new Promise<void>((resolve) => realImmediate(resolve));
    await expect(f.scope.captureFailure()).rejects.toBe(sink);
    expect(f.worker.shutdown).not.toHaveBeenCalled();
    expect(f.env.teardown).not.toHaveBeenCalled();
    f.stop();
    await expect(f.scope.finish()).rejects.toBe(sink);
    expect(f.env.teardown).toHaveBeenCalledTimes(1);
  });
  it('preserves both diagnostic output and cleanup errors when the final status sink also fails', async () => {
    const sink = new Error('sink failure');
    const cleanup = new Error('teardown failure');
    const f = await fixture(false, true, () => {
      throw sink;
    });
    vi.mocked(f.env.teardown).mockRejectedValue(cleanup);
    f.stop();
    await expect(f.scope.track(Promise.reject(new Error('original assertion')))).rejects.toThrow(
      'original assertion',
    );
    try {
      await f.scope.finish();
      expect.unreachable('cleanup must report unknown');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([sink, cleanup]);
    }
    expect(f.env.teardown).toHaveBeenCalledTimes(1);
  });
  it('captures a tracked early failure before manual finally closes the environment and preserves the original error', async () => {
    const f = await fixture();
    const original = new Error('synthetic assertion failure');
    f.stop();
    try {
      await expect(f.scope.track(Promise.reject(original))).rejects.toBe(original);
      expect(f.env.teardown).not.toHaveBeenCalled();
      expect(f.exactHandle.fetchHistory).toHaveBeenCalledTimes(1);
      expect(f.lines.map(parse)).toContainEqual(
        expect.objectContaining({ outcome: 'captured', kind: 'history', reason: 'test-body-failed' }),
      );
    } finally {
      await f.scope.closeEnvironment(f.env);
    }
    await f.scope.finish();
    expect(f.env.teardown).toHaveBeenCalledTimes(1);
    expect(f.exactHandle.fetchHistory).toHaveBeenCalledTimes(1);
  });
  it('keeps start/creation failures without a handle explicitly unknown and preserves the original error', async () => {
    const f = await fixture(false, false);
    const original = new Error('synthetic start failure');
    vi.mocked(f.env.client.workflow.start).mockRejectedValue(original);
    f.stop();
    await expect(
      f.scope.track(
        f.scope.start(f.env, 'taskWorkflow', {
          workflowId: 'workflow',
          taskQueue: 'q',
          args: [],
        }),
      ),
    ).rejects.toBe(original);
    await f.scope.finish();
    expect(f.lines.map(parse)).toContainEqual(
      expect.objectContaining({ outcome: 'unknown', code: 'no-started-run' }),
    );
    expect(f.exactHandle.fetchHistory).not.toHaveBeenCalled();
    expect(f.env.teardown).toHaveBeenCalledTimes(1);
  });
  it('starts the diagnostic clock before environment and Workflow start, without inventing a run', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const scope = new SyntheticHistoryDiagnostics({
      test: 'not started',
      testSha256: identity.testSha256,
      failed: () => false,
      output: new DiagnosticOutput((line) => lines.push(line)),
    });
    await vi.advanceTimersByTimeAsync(50_000);
    await scope.finish();
    expect(lines.map(parse)).toContainEqual(
      expect.objectContaining({ outcome: 'unknown', code: 'no-started-run' }),
    );
    expect(lines.map(parse).some((frame) => frame.type === 'begin')).toBe(false);
  });
  it('adds no reads, artifacts or output to a normal fast test', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.stop();
    await f.scope.finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.exactHandle.fetchHistory).not.toHaveBeenCalled();
    expect(f.withDeadline).not.toHaveBeenCalled();
    expect(f.lines).toEqual([]);
    expect(await readdir(f.root)).toEqual([]);
    expect(f.env.teardown).toHaveBeenCalledTimes(1);
  });
  it('takes exact-run bytes at 50 seconds under real SDK deadline context without stopping the worker', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.scope.mark('final-preflight-entered');
    await vi.advanceTimersByTimeAsync(49_999);
    expect(f.exactHandle.fetchHistory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.worker.shutdown).not.toHaveBeenCalled();
    f.stop();
    await f.scope.finish();
    expect(f.env.client.workflow.getHandle).toHaveBeenCalledWith('workflow', 'exact-run');
    expect(f.withDeadline).toHaveBeenCalledTimes(2);
    const deadlines = f.withDeadline.mock.calls.map(([deadline]) => deadline);
    expect(deadlines[0]).toBe(deadlines[1]);
    const histories = f.lines.filter((line) => parse(line).type !== 'status');
    const historyEnd = histories.findIndex((line) => parse(line).type === 'end');
    expect(decodeFrames(histories.slice(0, historyEnd + 1)).bytes).toEqual(f.raw);
    expect(f.lines.join('\n')).toContain('final-preflight-entered');
    expect(f.lines.join('\n')).not.toContain('must not appear');
    const dirs = await readdir(f.root);
    expect(dirs).toHaveLength(2);
    for (const dir of dirs) {
      const saved = JSON.parse(await readFile(join(f.root, dir, 'identity.json'), 'utf8'));
      if (saved.kind === 'history') expect(await readFile(join(f.root, dir, 'history.bin'))).toEqual(f.raw);
    }
  });
  it('reports a bounded stage timeline with entry times only when an exact run is captured', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(100);
      f.scope.mark(`stage-${i}-${'x'.repeat(100)}`);
    }
    f.scope.mark('replacement:new-request');
    await vi.advanceTimersByTimeAsync(50_000 - 3000);
    f.stop();
    await f.scope.finish();
    const timeline = f.lines.map(parse).find((frame) => frame.outcome === 'timeline');
    expect(timeline).toMatchObject({ reason: 'watchdog', stage: 'replacement:new-request', dropped: 9 });
    expect(timeline.stages).toHaveLength(24);
    expect(timeline.stages.at(-1)).toEqual(['replacement:new-request', 3000]);
    expect(timeline.stages.every(([name]: [string]) => name.length <= 64)).toBe(true);
    expect(timeline.elapsedMs).toBeGreaterThanOrEqual(50_000);
    expect(f.lines.map(parse)).toContainEqual(
      expect.objectContaining({ outcome: 'captured', kind: 'history', stage: 'replacement:new-request' }),
    );
  });
  it('waits for the actual worker Promise before teardown and deduplicates manual finally/afterEach', async () => {
    const f = await fixture();
    const finishing = f.scope.finish();
    await Promise.resolve();
    expect(f.worker.shutdown).toHaveBeenCalledTimes(1);
    expect(f.env.teardown).not.toHaveBeenCalled();
    f.stop();
    await finishing;
    await f.scope.closeEnvironment(f.env);
    expect(f.env.teardown).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(['shutdown', 'worker-run-settled', 'teardown']);
  });
  it('failed reads stay unknown and do not become an empty successful history', async () => {
    const f = await fixture(true);
    f.exactHandle.fetchHistory.mockRejectedValue(new Error('RPC rejected'));
    f.stop();
    await f.scope.finish();
    expect(f.lines.map(parse)).toContainEqual(
      expect.objectContaining({ outcome: 'unknown', kind: 'history', code: 'rpc-failed' }),
    );
    expect(f.lines.map(parse).filter((frame) => frame.type === 'begin' && frame.kind === 'history')).toEqual(
      [],
    );
  });
  it('reports a cleanup failure instead of claiming the environment is closed', async () => {
    const f = await fixture();
    vi.mocked(f.env.teardown).mockRejectedValue(new Error('close failed'));
    f.stop();
    await expect(f.scope.finish()).rejects.toThrow('close failed');
    expect(f.lines.map(parse)).toContainEqual(
      expect.objectContaining({ outcome: 'unknown', code: 'cleanup-failed' }),
    );
  });
});
