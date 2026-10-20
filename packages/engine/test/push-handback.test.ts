import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FakeWorld } from '../src/fakes.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { PortError } from '../src/ports.ts';
import type { PushHandbackPreflight, PushHandbackRequest } from '../src/push-handback.ts';
import { requestPushHandback as originalRequestPushHandback } from '../src/push-handback-client.ts';
import {
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskCloseClosedIssueUpdate,
  taskContinueSignal,
} from '../src/task-contract.ts';
import {
  freshRepo,
  withWorker as originalWithWorker,
  pollQuery,
  useEnv,
  type WorkerOptions,
  waitUntil,
} from './helpers.ts';
import { DiagnosticOutput, SyntheticHistoryDiagnostics } from './history-diagnostics.ts';
import { scripted } from './task-script.ts';

// #3413：PR #3412 首轮完整 CI（workflow run 39392992046 / job 118528847472，head
// d45207791e21faa6c7c166f5023b49fe18f21264，CI merge 71652455b385751c413650a5c9c99ce5d5a2032a，
// 2026-10-20T08:25:28Z）在 worker replacement 用例原 60 秒超时；当时本文件未取证，该 run 的原 history
// 缺失、等待阶段未知，收尾的 worker 引用/channel shutdown 报错不是根因证据。另一台 push-handback-contract
// 的 park-kind 重放错误（#3258）是别的用例、别的 run，不拿来顶替。之后本文件失败或 50 秒 watchdog
// 按精确 run 保全原 protobuf/describe 与阶段时间线；正常通过不读不写。
// 先登记 watchdog，再让 useEnv 的 beforeEach 创建服务端；不延后原测试的诊断时钟。
const output = new DiagnosticOutput();
const testSha256 = createHash('sha256')
  .update(readFileSync(new URL(import.meta.url)))
  .digest('hex');
const environmentScopes = new WeakMap<TestWorkflowEnvironment, SyntheticHistoryDiagnostics>();
const handleScopes = new WeakMap<object, SyntheticHistoryDiagnostics>();
let activeDiagnostics: SyntheticHistoryDiagnostics;
beforeEach((context) => {
  activeDiagnostics = new SyntheticHistoryDiagnostics({
    test: context.task.name,
    testSha256,
    output,
    failed: () => context.task.result?.state === 'fail',
  });
});
const environment = useEnv({
  beforeTeardown: () => activeDiagnostics.finish(),
  teardown: (env) => activeDiagnostics.closeEnvironment(env),
});
/** 用例体开头同步取：环境和本用例的诊断绑定，超时后还在跑的旧用例体不会记到下一条头上。 */
function testEnvironment() {
  const env = environment(),
    scope = activeDiagnostics;
  scope.environment(env);
  environmentScopes.set(env, scope);
  return env;
}
function envScope(env: TestWorkflowEnvironment) {
  const scope = environmentScopes.get(env);
  if (!scope) throw new Error('diagnostics: environment not registered');
  return scope;
}
function withWorker<T>(
  env: TestWorkflowEnvironment,
  world: FakeWorld,
  fn: (taskQueue: string) => Promise<T>,
  options: WorkerOptions,
  label = 'worker',
) {
  const scope = envScope(env);
  scope.mark(`${label}-create`);
  return scope.track(
    originalWithWorker(
      env,
      world,
      async (taskQueue) => {
        const value = await fn(taskQueue);
        // 用例体已结束，runUntil 接着关 worker 并等它真停。
        scope.mark(`${label}-shutdown`);
        return value;
      },
      { ...options, observeWorker: (worker, run, bundle) => scope.worker(env, worker, run, bundle) },
    ).then((value) => {
      scope.mark(`${label}-stopped`);
      return value;
    }),
  );
}
async function startWorkflow(
  env: TestWorkflowEnvironment,
  options: Parameters<TestWorkflowEnvironment['client']['workflow']['start']>[1],
) {
  const scope = envScope(env);
  const handle = await scope.start(env, 'taskWorkflow', options);
  handleScopes.set(handle, scope);
  return handle;
}
function scopeFor(handle: object) {
  const scope = handleScopes.get(handle);
  if (!scope) throw new Error('diagnostics: handle not registered');
  return scope;
}
function requestPushHandback(handle: WorkflowHandle, r: PushHandbackRequest, stage = 'handback-update') {
  scopeFor(handle).mark(stage);
  return originalRequestPushHandback(handle, r);
}
const success: PushHandbackPreflight = {
  outcome: 'natural-retired',
  head: 'a'.repeat(40),
  evidenceSha256: 'b'.repeat(64),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function task(): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 3343,
    title: 'permission push handback',
  };
}
function request(s: TaskStatus, id = 'request1'): PushHandbackRequest {
  const token = s.closedIssueClose?.token;
  if (!token) throw new Error('park token missing');
  return { version: 1, requestId: id, token, by: 'isolated-test', feedback: '修正写入工作流文件的交付' };
}
async function parked(h: WorkflowHandle, stage = 'parked-query') {
  scopeFor(h).mark(stage);
  return pollQuery(
    () => h.query<TaskStatus>('taskStatus'),
    (s) => s.phase === 'parked' && s.waiting?.kind === 'human',
    'permission push park',
  );
}
async function abandon(h: WorkflowHandle, stage = 'abandon-signal-and-result') {
  scopeFor(h).mark(stage);
  await h.signal(taskAbandonSignal, { by: 'test', reason: 'isolated teardown' });
  await h.result();
}
function world() {
  return createFakeWorld({
    push: () => new PortError('WORKFLOWS_PERMISSION', 'isolated failure', { retryable: false }),
  });
}

describe('permission push handback original park protocol', { timeout: 60_000 }, () => {
  it('unknown leaves original park unchanged; same business ID with changed payload reaches real Update conflict', async () => {
    const env = testEnvironment(),
      w = world(),
      { tasks, calls } = scripted();
    let reads = 0;
    tasks.readPushHandbackPreflight = async () => {
      reads++;
      return { outcome: 'unknown', code: 'missing_history' };
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const h = await startWorkflow(env, {
          workflowId: `handback-${randomUUID()}`,
          taskQueue,
          args: [task()],
        });
        const s = await parked(h),
          r = request(s);
        const first = await requestPushHandback(h, r);
        expect(first.outcome).toBe('unknown');
        expect(await requestPushHandback(h, r)).toEqual(first);
        expect((await requestPushHandback(h, { ...r, feedback: r.feedback + ' revised' })).outcome).toBe(
          'conflict',
        );
        expect(reads).toBe(1);
        expect(calls.segment).toHaveLength(1);
        expect(w.count('pushBranch')).toBe(1);
        expect((await parked(h)).closedIssueClose?.token).toEqual(s.closedIssueClose?.token);
        await abandon(h);
      },
      { tasks },
    );
  });

  it('accepted and ready do not succeed before main loop consumes; duplicate returns same receipt', async () => {
    const env = testEnvironment(),
      w = world(),
      { tasks, calls } = scripted();
    const checked = deferred<PushHandbackPreflight>(),
      round = deferred<void>(),
      roundEntered = deferred<void>();
    let reads = 0,
      settled = false;
    tasks.readPushHandbackPreflight = async () => {
      reads++;
      return checked.promise;
    };
    const original = w.ports.recordRound;
    w.ports.recordRound = async (i, c) => {
      roundEntered.resolve();
      await round.promise;
      return original(i, c);
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const h = await startWorkflow(env, {
          workflowId: `handback-${randomUUID()}`,
          taskQueue,
          args: [task()],
        });
        const r = request(await parked(h));
        const result = requestPushHandback(h, r).then((x) => {
          settled = true;
          return x;
        });
        await Promise.race([
          waitUntil(() => reads === 1, 'preflight entered'),
          result.then((r) => {
            throw new Error(`preflight never entered: ${JSON.stringify(r)}`);
          }),
        ]);
        expect(settled).toBe(false);
        expect(
          await h.executeUpdate(taskCloseClosedIssueUpdate, {
            args: [{ token: r.token, command: { by: 'test', reason: 'must not close pending handback' } }],
          }),
        ).toBe('busy');
        checked.resolve(success);
        await roundEntered.promise;
        expect(settled).toBe(false);
        expect(calls.segment).toHaveLength(1);
        round.resolve();
        const receipt = await result;
        expect(receipt.outcome).toBe('handed_back');
        expect(await requestPushHandback(h, r)).toEqual(receipt);
        await waitUntil(() => calls.segment.length === 2, 'next bounded segment');
        expect(calls.segment[1]?.resumeSessionId).toBeUndefined();
        expect(reads).toBe(1);
        await abandon(h);
      },
      { tasks, maxCachedWorkflows: 0 },
    );
  });

  it.each(['continue', 'abandon'] as const)(
    '%s during trusted IO makes late evidence stale and finishes handlers',
    async (control) => {
      const env = testEnvironment(),
        w = world(),
        { tasks, calls } = scripted(),
        read = deferred<PushHandbackPreflight>();
      let entered = false;
      tasks.readPushHandbackPreflight = async () => {
        entered = true;
        return read.promise;
      };
      await withWorker(
        env,
        w,
        async (taskQueue) => {
          const h = await startWorkflow(env, {
            workflowId: `handback-${randomUUID()}`,
            taskQueue,
            args: [task()],
          });
          const result = requestPushHandback(h, request(await parked(h)));
          await waitUntil(() => entered, 'trusted IO');
          if (control === 'continue') await h.signal(taskContinueSignal, { by: 'test' });
          else await h.signal(taskAbandonSignal, { by: 'test', reason: 'during IO' });
          read.resolve(success);
          expect((await result).outcome).toBe('stale');
          if (control === 'continue') {
            await parked(h);
            expect(calls.segment).toHaveLength(1);
            await abandon(h);
          } else expect(((await h.result()) as { outcome: string }).outcome).toBe('abandoned');
        },
        { tasks },
      );
    },
  );

  it('token budget held never wakes park or spends a new grant', async () => {
    const env = testEnvironment(),
      w = world(),
      { tasks, calls } = scripted();
    tasks.readPushHandbackPreflight = async () => ({ outcome: 'budget-held', code: 'token_budget' });
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const h = await startWorkflow(env, {
          workflowId: `handback-${randomUUID()}`,
          taskQueue,
          args: [task()],
        });
        const s = await parked(h);
        expect((await requestPushHandback(h, request(s))).outcome).toBe('budget-held');
        expect(calls.segment).toHaveLength(1);
        expect((await parked(h)).round).toBe(s.round);
        expect(w.count('pushBranch')).toBe(1);
        await abandon(h);
      },
      { tasks },
    );
  });

  it('continue after ready but before main-loop accept cannot receive handed_back', async () => {
    const env = testEnvironment(),
      w = world(),
      { tasks } = scripted(),
      round = deferred<void>(),
      entered = deferred<void>();
    tasks.readPushHandbackPreflight = async () => success;
    const original = w.ports.recordRound;
    w.ports.recordRound = async (i, c) => {
      entered.resolve();
      await round.promise;
      return original(i, c);
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const h = await startWorkflow(env, {
          workflowId: `handback-${randomUUID()}`,
          taskQueue,
          args: [task()],
        });
        const result = requestPushHandback(h, request(await parked(h)));
        await entered.promise;
        await h.signal(taskContinueSignal, { by: 'test' });
        round.resolve();
        expect((await result).outcome).toBe('stale');
        await abandon(h);
      },
      { tasks },
    );
  });

  it('saturated implementation rounds reject before preflight and cannot trigger automatic round reset', async () => {
    const env = testEnvironment(),
      w = world(),
      { tasks, calls } = scripted({
        delivery: (n) => ({ head: 'a'.repeat(40), commits: n < 3 ? 0 : 1, changedFiles: ['code.ts'] }),
      });
    let reads = 0;
    tasks.readPushHandbackPreflight = async () => {
      reads++;
      return success;
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const h = await startWorkflow(env, {
          workflowId: `handback-${randomUUID()}`,
          taskQueue,
          args: [task()],
        });
        const s = await parked(h);
        expect(s.round).toBe(3);
        expect((await requestPushHandback(h, request(s))).outcome).toBe('budget-held');
        expect(reads).toBe(0);
        expect(calls.segment).toHaveLength(3);
        expect((await parked(h)).round).toBe(3);
        await abandon(h);
      },
      { tasks },
    );
  });

  it('same run reconstructs business receipts after worker replacement, then accepts one new request', async () => {
    const env = testEnvironment(),
      w = world(),
      { tasks, calls } = scripted(),
      taskQueue = `handback-${randomUUID()}`;
    let h: WorkflowHandle | undefined, r: PushHandbackRequest | undefined;
    tasks.readPushHandbackPreflight = async () => ({ outcome: 'unknown', code: 'first_observation' });
    await withWorker(
      env,
      w,
      async () => {
        h = await startWorkflow(env, {
          workflowId: `handback-${randomUUID()}`,
          taskQueue,
          args: [task()],
        });
        r = request(await parked(h, 'first-worker:parked-query'));
        expect((await requestPushHandback(h, r, 'first-worker:original-request')).outcome).toBe('unknown');
      },
      { tasks, taskQueue, maxCachedWorkflows: 0 },
      'first-worker',
    );
    tasks.readPushHandbackPreflight = async () => success;
    await withWorker(
      env,
      w,
      async () => {
        const handle = h!,
          original = r!;
        expect((await requestPushHandback(handle, original, 'replacement:duplicate-request')).outcome).toBe(
          'unknown',
        );
        expect(
          (
            await requestPushHandback(
              handle,
              { ...original, feedback: 'different' },
              'replacement:changed-payload-request',
            )
          ).outcome,
        ).toBe('conflict');
        expect(
          (
            await requestPushHandback(
              handle,
              { ...original, requestId: 'newObservation' },
              'replacement:new-request',
            )
          ).outcome,
        ).toBe('handed_back');
        scopeFor(handle).mark('replacement:await-second-segment');
        await waitUntil(() => calls.segment.length === 2, 'new bounded segment after worker replacement');
        await abandon(handle, 'replacement:abandon-signal-and-result');
      },
      { tasks, taskQueue, maxCachedWorkflows: 0 },
      'replacement-worker',
    );
  });
  it('future hold generation rejects immediately without preflight or a stranded terminal handler', async () => {
    const env = testEnvironment(),
      w = world(),
      { tasks } = scripted();
    let reads = 0;
    tasks.readPushHandbackPreflight = async () => {
      reads++;
      return success;
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const h = await startWorkflow(env, {
          workflowId: `handback-${randomUUID()}`,
          taskQueue,
          args: [task()],
        });
        const r = request(await parked(h));
        r.token = { ...r.token, generation: 2 };
        expect(await requestPushHandback(h, r)).toMatchObject({ outcome: 'stale', code: 'unsupported_hold' });
        expect(reads).toBe(0);
        await abandon(h);
      },
      { tasks, maxCachedWorkflows: 0 },
    );
  });
});
