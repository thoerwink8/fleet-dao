import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import type { Worker, WorkflowBundle } from '@temporalio/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOTATION_LIMIT,
  ANNOTATION_PREFIX,
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
  it('rejects a stage that is not a fixed label instead of treating the frame as bound', () => {
    const frames = encodeFrames(
      'history',
      { ...identity, stage: '修正写入工作流文件的交付' },
      randomBytes(32),
    );
    expect(() => decodeFrames(frames)).toThrow('identity');
    const blank = encodeFrames('history', { ...identity, stage: '' }, randomBytes(32));
    expect(() => decodeFrames(blank)).toThrow('identity');
  });
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
    annotations: string[] = [],
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
    output: new DiagnosticOutput(
      (line) => {
        lines.push(line);
        emit?.(line);
      },
      (line) => annotations.push(line),
    ),
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
  return { scope, env, worker, run, stop, lines, annotations, exactHandle, withDeadline, root, raw, order };
}

const annotationOf = (line: string) => {
  expect(line.startsWith(ANNOTATION_PREFIX)).toBe(true);
  const data = line.slice(ANNOTATION_PREFIX.length);
  expect(data).not.toMatch(/[\r\n]/);
  return JSON.parse(data.replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%25/g, '%'));
};

describe('#3413 public Actions annotation for a CI capture', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it('binds each captured read to workflow, run, stage, ciSha and byte SHA-256 without frames or business text', async () => {
    vi.stubEnv('GITHUB_SHA', 'c'.repeat(40));
    const f = await fixture(true);
    f.scope.mark('wait:first-worker:parked-query');
    f.stop();
    await f.scope.finish();
    const published = f.annotations.map(annotationOf);
    expect(published.map((a) => a.kind)).toEqual(['history', 'describe']);
    expect(published[0]).toMatchObject({
      outcome: 'captured',
      test: 'synthetic',
      workflowId: 'workflow',
      runId: 'exact-run',
      stage: 'wait:first-worker:parked-query',
      reason: 'test-failed',
      ciSha: 'c'.repeat(40),
      testSha256: identity.testSha256,
      bytes: f.raw.length,
      sha256: createHash('sha256').update(f.raw).digest('hex'),
    });
    // 注解的 hash 和日志帧里的同一份字节对得上。
    const frames = f.lines.filter((line) => parse(line).type !== 'status');
    const end = frames.findIndex((line) => parse(line).type === 'end');
    expect(decodeFrames(frames.slice(0, end + 1)).identity.ciSha).toBe('c'.repeat(40));
    expect(parse(frames[0] ?? '').sha256).toBe(published[0].sha256);
    const joined = f.annotations.join('\n');
    expect(joined).not.toContain(PREFIX);
    expect(joined).not.toContain('must not appear');
    expect(joined).not.toContain(f.raw.toString('base64').slice(0, 32));
  });
  it('a passing test publishes nothing', async () => {
    const f = await fixture();
    f.stop();
    await f.scope.finish();
    expect(f.annotations).toEqual([]);
  });
  it('failed reads publish unknown with the code, never a captured hash', async () => {
    const f = await fixture(true);
    f.exactHandle.fetchHistory.mockRejectedValue(new Error('RPC rejected'));
    f.scope.mark('修正写入工作流文件的交付');
    f.stop();
    await f.scope.finish();
    const [history] = f.annotations.map(annotationOf);
    expect(history).toMatchObject({
      outcome: 'unknown',
      kind: 'history',
      runId: 'exact-run',
      code: 'rpc-failed',
    });
    expect(history.sha256).toBeUndefined();
    expect(history.stage).toBe('unlabeled');
    expect(f.annotations.join('\n')).not.toContain('修正');
  });
  it('defaults on only for the real file sink inside Actions, escapes % and caps the count', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const value = {
      outcome: 'unknown',
      test: '100% x',
      reason: 'watchdog',
      stage: 'a',
      ciSha: 'unknown',
    } as const;
    vi.stubEnv('GITHUB_ACTIONS', '');
    expect(new DiagnosticOutput().annotation(value)).toBe(false);
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    expect(new DiagnosticOutput(() => undefined).annotation(value)).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    const output = new DiagnosticOutput();
    expect(output.annotation(value)).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain('"test":"100%25 x"');
    for (let i = 1; i < ANNOTATION_LIMIT; i++) expect(output.annotation(value)).toBe(true);
    expect(output.annotation(value)).toBe(false);
    expect(errors).toHaveBeenCalledTimes(ANNOTATION_LIMIT);
  });
});

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
  it('binds each scope stage inside that run frame and drops unsafe stage text', async () => {
    const left = await fixture(true);
    const right = await fixture(true);
    const business = '修正写入工作流文件的交付';
    left.scope.mark('wait:replacement:reconstruct-update');
    right.scope.mark(business);
    left.stop();
    right.stop();
    await left.scope.finish();
    await right.scope.finish();
    const historyOf = (lines: string[]) => {
      const frames = lines.filter((line) => parse(line).type !== 'status');
      const end = frames.findIndex((line) => parse(line).type === 'end');
      return decodeFrames(frames.slice(0, end + 1));
    };
    const leftHistory = historyOf(left.lines);
    const rightHistory = historyOf(right.lines);
    expect(leftHistory.identity).toMatchObject({
      workflowId: 'workflow',
      runId: 'exact-run',
      stage: 'wait:replacement:reconstruct-update',
    });
    expect(leftHistory.bytes).toEqual(left.raw);
    expect(rightHistory.identity.stage).toBe('unlabeled');
    expect(rightHistory.bytes).toEqual(right.raw);
    const labels = (lines: string[]) =>
      lines.map(parse).flatMap((frame) => {
        const values = [frame.stage, frame.identity?.stage];
        return values.filter((value): value is string => typeof value === 'string');
      });
    expect(labels(left.lines)).toContain('wait:replacement:reconstruct-update');
    expect(labels(left.lines)).not.toContain('unlabeled');
    expect(labels(right.lines)).toContain('unlabeled');
    expect(labels(right.lines)).not.toContain('wait:replacement:reconstruct-update');
    expect(left.lines.join('\n')).not.toContain(business);
    expect(right.lines.join('\n')).not.toContain(business);
    for (const dir of await readdir(right.root)) {
      expect(await readFile(join(right.root, dir, 'identity.json'), 'utf8')).not.toContain(business);
    }
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
    const frames = f.lines.filter((line) => parse(line).type !== 'status');
    const ends = frames.flatMap((line, index) => (parse(line).type === 'end' ? [index] : []));
    expect(ends).toHaveLength(2);
    const historyEnd = ends[0];
    const describeEnd = ends[1];
    if (historyEnd === undefined || describeEnd === undefined) throw new Error('frames');
    const history = decodeFrames(frames.slice(0, historyEnd + 1));
    const described = decodeFrames(frames.slice(historyEnd + 1, describeEnd + 1));
    expect(history.bytes).toEqual(f.raw);
    expect(history.kind).toBe('history');
    expect(described.kind).toBe('describe');
    for (const decoded of [history, described]) {
      expect(decoded.identity).toMatchObject({
        workflowId: 'workflow',
        runId: 'exact-run',
        stage: 'final-preflight-entered',
      });
    }
    expect(f.lines.map(parse)).toContainEqual(
      expect.objectContaining({
        outcome: 'captured',
        kind: 'history',
        runId: 'exact-run',
        stage: 'final-preflight-entered',
      }),
    );
    expect(f.lines.join('\n')).not.toContain('must not appear');
    const dirs = await readdir(f.root);
    expect(dirs).toHaveLength(2);
    for (const dir of dirs) {
      const saved = JSON.parse(await readFile(join(f.root, dir, 'identity.json'), 'utf8'));
      if (saved.kind === 'history') {
        expect(saved).toMatchObject({ runId: 'exact-run', stage: 'final-preflight-entered' });
        expect(await readFile(join(f.root, dir, 'history.bin'))).toEqual(f.raw);
      }
    }
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
