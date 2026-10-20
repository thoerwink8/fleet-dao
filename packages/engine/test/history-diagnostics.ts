// 仅 push-handback-contract 全假端口测试启用：保留原 protobuf 字节，失败不伪装成空历史。
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { WorkflowHandle, WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import type { Worker, WorkflowBundle } from '@temporalio/worker';

export const HISTORY_LIMIT = 2 * 1024 * 1024;
export const DESCRIBE_LIMIT = 128 * 1024;
export const OUTPUT_LIMIT = 8 * 1024 * 1024;
export const PREFIX = 'FLEET_SYNTHETIC_HISTORY_V1 ';
const STATUS_RESERVE = 32 * 1024;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const settled = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
type Identity = {
  test: string;
  workflowId: string;
  runId: string;
  bundleSha256: string;
  testSha256: string;
  ciSha: string;
};
type Frame =
  | {
      type: 'begin';
      id: string;
      kind: 'history' | 'describe';
      identity: Identity;
      bytes: number;
      sha256: string;
      chunks: number;
    }
  | { type: 'chunk'; id: string; index: number; data: string }
  | { type: 'end'; id: string; sha256: string };

export function encodeFrames(kind: 'history' | 'describe', identity: Identity, bytes: Uint8Array): string[] {
  if (bytes.length > (kind === 'history' ? HISTORY_LIMIT : DESCRIBE_LIMIT)) throw new Error('byte-limit');
  const data = gzipSync(bytes).toString('base64');
  const chunks = data.match(/.{1,8192}/g) ?? [];
  const id = randomUUID();
  const sha256 = hash(bytes);
  const frames: Frame[] = [
    { type: 'begin', id, kind, identity, bytes: bytes.length, sha256, chunks: chunks.length },
    ...chunks.map((data, index): Frame => ({ type: 'chunk', id, index, data })),
    { type: 'end', id, sha256 },
  ];
  return frames.map((frame) => `${PREFIX}${JSON.stringify(frame)}`);
}

/** 从完整的一组帧恢复原始 protobuf/describe 字节；缺 END、重复或混帧一律拒绝。 */
export function decodeFrames(lines: readonly string[]): {
  identity: Identity;
  kind: 'history' | 'describe';
  bytes: Buffer;
} {
  if (lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0) > OUTPUT_LIMIT)
    throw new Error('output-limit');
  const frames = lines.map((line) => {
    if (!line.startsWith(PREFIX)) throw new Error('prefix');
    return JSON.parse(line.slice(PREFIX.length)) as Frame;
  });
  const first = frames[0],
    last = frames.at(-1);
  if (first?.type !== 'begin' || last?.type !== 'end') throw new Error('incomplete');
  const limit = first.kind === 'history' ? HISTORY_LIMIT : first.kind === 'describe' ? DESCRIBE_LIMIT : 0;
  if (
    !limit ||
    !Number.isInteger(first.bytes) ||
    first.bytes < 0 ||
    first.bytes > limit ||
    !Number.isInteger(first.chunks) ||
    first.chunks < 1 ||
    frames.length !== first.chunks + 2 ||
    typeof first.id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(first.sha256) ||
    last.id !== first.id ||
    last.sha256 !== first.sha256
  )
    throw new Error('invalid-envelope');
  if (
    !first.identity ||
    Object.values(first.identity).some((v) => typeof v !== 'string' || v.length > 512) ||
    !['test', 'workflowId', 'runId', 'bundleSha256', 'testSha256', 'ciSha'].every(
      (key) => key in first.identity,
    )
  ) {
    throw new Error('identity');
  }
  const chunks = frames.slice(1, -1).map((frame, index) => {
    if (
      frame.type !== 'chunk' ||
      frame.id !== first.id ||
      frame.index !== index ||
      typeof frame.data !== 'string' ||
      frame.data.length > 8192 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)
    ) {
      throw new Error('invalid-chunk');
    }
    return frame.data;
  });
  const base64 = chunks.join('');
  const compressed = Buffer.from(base64, 'base64');
  if (compressed.toString('base64') !== base64) throw new Error('invalid-base64');
  const bytes = gunzipSync(compressed, { maxOutputLength: limit });
  if (bytes.length !== first.bytes || hash(bytes) !== first.sha256) throw new Error('digest');
  return { identity: first.identity, kind: first.kind, bytes };
}

/** 文件共享的输出账：状态保留独立额度，超限明确 unknown，不输出半组帧。 */
export class DiagnosticOutput {
  private dataBytes = 0;
  private statusBytes = 0;
  private readonly emit: (line: string) => void;
  constructor(emit: (line: string) => void = (line) => console.error(line)) {
    this.emit = emit;
  }
  frames(lines: string[]): void {
    const bytes = lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
    if (this.dataBytes + bytes > OUTPUT_LIMIT - STATUS_RESERVE) throw new Error('file-output-limit');
    this.dataBytes += bytes;
    for (const line of lines) this.emit(line);
  }
  status(value: Record<string, unknown>): void {
    const line = `${PREFIX}${JSON.stringify({ type: 'status', ...value })}`;
    const bytes = Buffer.byteLength(line) + 1;
    if (this.statusBytes + bytes > STATUS_RESERVE) throw new Error('status-output-limit');
    this.statusBytes += bytes;
    this.emit(line);
  }
}

type WorkerEntry = {
  env: TestWorkflowEnvironment;
  worker: Worker;
  settled: Promise<PromiseSettledResult<unknown>>;
};
type Run = { env: TestWorkflowEnvironment; handle: WorkflowHandle; workflowId: string; runId: string };
type WatchdogScheduler = (onFire: () => void, delayMs: number) => () => void;
const scheduleWatchdog: WatchdogScheduler = (onFire, delayMs) => {
  const timer = setTimeout(onFire, delayMs);
  return () => clearTimeout(timer);
};

export class SyntheticHistoryDiagnostics {
  private stage = 'test-start';
  private readonly cancelWatchdog: () => void;
  private capturePromise?: Promise<void>;
  private finished = false;
  private readonly workers: WorkerEntry[] = [];
  private readonly operations: Promise<PromiseSettledResult<unknown>>[] = [];
  private readonly environments = new Map<TestWorkflowEnvironment, Promise<void> | undefined>();
  private readonly runs: Run[] = [];
  private bundleSha256 = 'unknown';
  private finishPromise?: Promise<void>;
  private readonly options: {
    test: string;
    testSha256: string;
    output: DiagnosticOutput;
    failed: () => boolean;
    // 在本文件 beforeEach 的第一个钩子中创建，先于 useEnv 的服务端创建。
    watchdogMs?: number;
    // 真实诊断夹具可在 host 屏障就绪后触发；默认仍使用原生计时器。
    scheduleWatchdog?: WatchdogScheduler;
    artifactRoot?: string;
  };
  constructor(options: SyntheticHistoryDiagnostics['options']) {
    this.options = options;
    this.cancelWatchdog = (options.scheduleWatchdog ?? scheduleWatchdog)(() => {
      // 原拒绝保留在 capturePromise，finish 独立报告；定时器不能制造未处理拒绝。
      void this.capture('watchdog').catch(() => undefined);
    }, options.watchdogMs ?? 50_000);
  }
  mark(stage: string): void {
    this.stage = stage;
  }
  environment(env: TestWorkflowEnvironment): TestWorkflowEnvironment {
    if (!this.environments.has(env)) this.environments.set(env, undefined);
    if (this.finished) throw new Error('diagnostics: environment arrived after test finished');
    return env;
  }
  track<T>(run: Promise<T>): Promise<T> {
    const observed = run.catch(async (error) => {
      // 写出故障仍由 finish 的原 capturePromise 报出，不替换此处原业务错误/堆栈。
      await this.captureFailure().catch(() => undefined);
      throw error;
    });
    this.operations.push(settled(observed));
    return observed;
  }
  worker(env: TestWorkflowEnvironment, worker: Worker, run: Promise<unknown>, bundle: WorkflowBundle): void {
    if (!this.environments.has(env)) this.environments.set(env, undefined);
    this.bundleSha256 = hash(bundle.code);
    this.workers.push({ env, worker, settled: settled(run) });
    if (this.finished && worker.getState() === 'RUNNING') worker.shutdown();
  }
  async start(
    env: TestWorkflowEnvironment,
    ...args: Parameters<TestWorkflowEnvironment['client']['workflow']['start']>
  ): Promise<WorkflowHandleWithFirstExecutionRunId> {
    if (this.finished) throw new Error('diagnostics: test already finished');
    this.mark('workflow-start');
    const handle = await env.client.workflow.start(...args);
    this.runs.push({
      env,
      handle: env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId),
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    });
    this.mark('workflow-started');
    return handle;
  }
  private capture(reason: string): Promise<void> {
    this.capturePromise ??= this.read(reason).catch(() => {
      this.options.output.status({
        outcome: 'unknown',
        test: this.options.test.slice(0, 512),
        code: 'capture-failed',
      });
    });
    return this.capturePromise;
  }
  /** 必须在 manual finally 关环境之前调用；保留原失败对象，由调用者原样抛出。 */
  captureFailure(): Promise<void> {
    return this.capture('test-body-failed');
  }
  private async read(reason: string): Promise<void> {
    const stage = this.stage;
    if (!this.runs.length)
      this.options.output.status({
        outcome: 'unknown',
        reason,
        stage,
        code: 'no-started-run',
        test: this.options.test.slice(0, 512),
      });
    for (const run of this.runs) {
      const identity: Identity = {
        test: this.options.test.slice(0, 512),
        workflowId: run.workflowId,
        runId: run.runId,
        bundleSha256: this.bundleSha256,
        testSha256: this.options.testSha256,
        ciSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')
          ? String(process.env.GITHUB_SHA)
          : 'unknown',
      };
      const deadline = Date.now() + 3000;
      // SDK 的 deadline 作用于分页内部的每次真实 RPC，不能用悬空的 Promise.race 冒充取消。
      const result = await Promise.allSettled([
        run.env.client.connection.withDeadline(deadline, async () => {
          const history = await run.handle.fetchHistory();
          const encoder = history.constructor as unknown as {
            encode(message: unknown): { finish(): Uint8Array };
          };
          if (typeof encoder.encode !== 'function') throw new Error('protobuf-encoder-unavailable');
          return Buffer.from(encoder.encode(history).finish());
        }),
        run.env.client.connection.withDeadline(deadline, async () => {
          const d = await run.handle.describe();
          return Buffer.from(
            JSON.stringify({
              workflowId: d.workflowId,
              runId: d.runId,
              status: d.status,
              historyLength: d.historyLength,
              pendingActivityCount: d.raw.pendingActivities?.length ?? 0,
              pendingActivitiesTruncated: (d.raw.pendingActivities?.length ?? 0) > 64,
              pendingActivities: d.raw.pendingActivities?.slice(0, 64).map((a) => ({
                activityId: a.activityId,
                activityType: a.activityType?.name,
                state: a.state,
                attempt: a.attempt,
                scheduledTime: a.scheduledTime,
                startedTime: a.lastStartedTime,
              })),
            }),
          );
        }),
      ]);
      for (const [index, value] of result.entries()) {
        const kind = index === 0 ? 'history' : 'describe';
        try {
          if (value.status !== 'fulfilled') throw new Error('rpc-failed');
          const frames = encodeFrames(kind, identity, value.value);
          const dir = join(this.options.artifactRoot ?? '_tmp/synthetic-history', randomUUID());
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `${kind}.bin`), value.value, { flag: 'wx' });
          await writeFile(
            join(dir, 'identity.json'),
            JSON.stringify({ ...identity, kind, stage, reason, sha256: hash(value.value) }),
            { flag: 'wx' },
          );
          this.options.output.frames(frames);
          this.options.output.status({ outcome: 'captured', kind, runId: run.runId, stage, reason });
        } catch (error) {
          this.options.output.status({
            outcome: 'unknown',
            kind,
            runId: run.runId,
            stage,
            reason,
            code: error instanceof Error ? error.message.slice(0, 80) : 'capture-failed',
          });
        }
      }
    }
  }
  closeEnvironment(env: TestWorkflowEnvironment): Promise<void> {
    if (!this.environments.has(env)) this.environments.set(env, undefined);
    let closing = this.environments.get(env);
    if (!closing) {
      closing = (async () => {
        const workers = this.workers.filter((entry) => entry.env === env);
        await Promise.all(workers.map((entry) => entry.settled));
        if (workers.some(({ worker }) => !['STOPPED', 'FAILED'].includes(worker.getState()))) {
          throw new Error('diagnostics: worker closure unknown; environment retained');
        }
        await env.teardown();
      })();
      this.environments.set(env, closing);
    }
    return closing;
  }
  finish(): Promise<void> {
    this.finishPromise ??= this.close();
    return this.finishPromise;
  }
  private async close(): Promise<void> {
    this.cancelWatchdog();
    const problems: unknown[] = [];
    try {
      if (this.options.failed()) await this.capture('test-failed');
      else await this.capturePromise;
    } catch (error) {
      problems.push(error);
    }
    // 只在测试已成功/失败/超时后关闭。watchdog 本身不改变 worker 或业务屏障。
    this.finished = true;
    for (const { worker } of this.workers) {
      try {
        if (worker.getState() === 'RUNNING') worker.shutdown();
      } catch (error) {
        problems.push(error);
      }
    }
    await Promise.all(this.operations);
    await Promise.all(this.workers.map((entry) => entry.settled));
    const results = await Promise.allSettled(
      [...this.environments.keys()].map((env) => this.closeEnvironment(env)),
    );
    problems.push(...results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : [])));
    if (problems.length) {
      try {
        this.options.output.status({
          outcome: 'unknown',
          code: 'cleanup-failed',
          test: this.options.test.slice(0, 512),
        });
      } catch (error) {
        problems.push(error);
      }
      const unique = [...new Set(problems)];
      if (unique.length === 1) throw unique[0];
      throw new AggregateError(unique, 'diagnostics: capture or environment cleanup failed');
    }
  }
}
