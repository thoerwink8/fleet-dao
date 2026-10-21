import { randomUUID } from 'node:crypto';
import type { WorkflowHandle } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import { createFakeWorld } from '../src/fakes.ts';
import { PortError } from '../src/ports.ts';
import type { PushHandbackPreflight, PushHandbackRequest } from '../src/push-handback.ts';
import { requestPushHandback } from '../src/push-handback-client.ts';
import {
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskCloseClosedIssueUpdate,
  taskContinueSignal,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, waitUntil, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const environment = useEnv();
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
async function parked(h: WorkflowHandle) {
  return pollQuery(
    () => h.query<TaskStatus>('taskStatus'),
    (s) => s.phase === 'parked' && s.waiting?.kind === 'human',
    'permission push park',
  );
}
async function abandon(h: WorkflowHandle) {
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
    const env = environment(),
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
        const h = await env.client.workflow.start('taskWorkflow', {
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
    const env = environment(),
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
        const h = await env.client.workflow.start('taskWorkflow', {
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
      const env = environment(),
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
          const h = await env.client.workflow.start('taskWorkflow', {
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
    const env = environment(),
      w = world(),
      { tasks, calls } = scripted();
    tasks.readPushHandbackPreflight = async () => ({ outcome: 'budget-held', code: 'token_budget' });
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const h = await env.client.workflow.start('taskWorkflow', {
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
    const env = environment(),
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
        const h = await env.client.workflow.start('taskWorkflow', {
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
    const env = environment(),
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
        const h = await env.client.workflow.start('taskWorkflow', {
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
    const env = environment(),
      w = world(),
      { tasks, calls } = scripted(),
      taskQueue = `handback-${randomUUID()}`;
    let h: WorkflowHandle | undefined, r: PushHandbackRequest | undefined;
    tasks.readPushHandbackPreflight = async () => ({ outcome: 'unknown', code: 'first_observation' });
    await withWorker(
      env,
      w,
      async () => {
        h = await env.client.workflow.start('taskWorkflow', {
          workflowId: `handback-${randomUUID()}`,
          taskQueue,
          args: [task()],
        });
        r = request(await parked(h));
        expect((await requestPushHandback(h, r)).outcome).toBe('unknown');
      },
      { tasks, taskQueue, maxCachedWorkflows: 0 },
    );
    tasks.readPushHandbackPreflight = async () => success;
    await withWorker(
      env,
      w,
      async () => {
        const handle = h!,
          original = r!;
        expect((await requestPushHandback(handle, original)).outcome).toBe('unknown');
        expect((await requestPushHandback(handle, { ...original, feedback: 'different' })).outcome).toBe(
          'conflict',
        );
        expect(
          (await requestPushHandback(handle, { ...original, requestId: 'newObservation' })).outcome,
        ).toBe('handed_back');
        await waitUntil(() => calls.segment.length === 2, 'new bounded segment after worker replacement');
        await abandon(handle);
      },
      { tasks, taskQueue, maxCachedWorkflows: 0 },
    );
  });
  it('future hold generation rejects immediately without preflight or a stranded terminal handler', async () => {
    const env = environment(),
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
        const h = await env.client.workflow.start('taskWorkflow', {
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
