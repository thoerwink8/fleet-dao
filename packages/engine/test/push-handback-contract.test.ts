import { randomUUID } from 'node:crypto';
import type { WorkflowHandle } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import { createFakeWorld } from '../src/fakes.ts';
import { PortError } from '../src/ports.ts';
import type { PushHandbackPreflight, PushHandbackRequest } from '../src/push-handback.ts';
import { requestPushHandback } from '../src/push-handback-client.ts';
import { buildTaskBrief, type TaskBrief } from '../src/runner/task-brief.ts';
import {
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskContinueSignal,
} from '../src/task-contract.ts';
import { createRealEnv, freshRepo, pollQuery, useEnv, waitUntil, withWorker } from './helpers.ts';
import { BODY, scripted } from './task-script.ts';

const environment = useEnv();
function brief(revision: string): TaskBrief {
  const result = buildTaskBrief({
    issue: {
      number: 3361,
      title: 'permission contract revision',
      state: 'open',
      body: `${BODY}\n\n## 正式返工\n\n${revision}\n`,
    },
  });
  if (!result.ok) throw new Error('invalid synthetic requirement');
  return result.brief;
}
const h0 = brief('H0 original'),
  h1 = brief('H1 remove forbidden changes'),
  h2 = brief('H2 newest instructions');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function input(): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 3361,
    title: 'contract handback',
  };
}
const parked = (handle: WorkflowHandle) =>
  pollQuery(
    () => handle.query<TaskStatus>('taskStatus'),
    (s) => s.phase === 'parked' && s.waiting?.kind === 'human',
    'permission original hold',
  );
function request(s: TaskStatus, requestId = 'contract-snapshot'): PushHandbackRequest {
  const token = s.closedIssueClose?.token;
  if (!token || !h0.contract || !h1.contract) throw new Error('missing synthetic identity');
  return {
    version: 2,
    requestId,
    token,
    by: 'isolated',
    feedback: 'remove forbidden changes',
    originalContract: h0.contract,
    expectedContract: h1.contract,
  };
}
const success = (): PushHandbackPreflight => ({
  outcome: 'natural-retired',
  head: 'a'.repeat(40),
  evidenceSha256: 'b'.repeat(64),
  brief: h1,
});
async function abandon(handle: WorkflowHandle) {
  await handle.signal(taskAbandonSignal, { by: 'test', reason: 'isolated teardown' });
  await handle.result();
}
function world() {
  return createFakeWorld({
    push: () => new PortError('WORKFLOWS_PERMISSION', 'isolated failure', { retryable: false }),
  });
}

describe('permission contract snapshot consumption', { timeout: 60_000 }, () => {
  it.each(['final-read', 'accepted-round'] as const)(
    'real Workflow cancellation during %s never signs control consumption or starts a session',
    async (stage) => {
      const env = await createRealEnv(),
        w = world(),
        { tasks, calls } = scripted({ brief: () => ({ ok: true, brief: h0 }) });
      const entered = deferred<void>(),
        release = deferred<void>();
      let reads = 0;
      tasks.readPushHandbackPreflight = async () => {
        if (++reads === 2 && stage === 'final-read') {
          entered.resolve();
          await release.promise;
        }
        return success();
      };
      w.ports.recordRound = async () => {
        if (stage === 'accepted-round') {
          entered.resolve();
          await release.promise;
        }
      };
      try {
        await withWorker(
          env,
          w,
          async (taskQueue) => {
            const handle = await env.client.workflow.start('taskWorkflow', {
              workflowId: `contract-cancel-${randomUUID()}`,
              taskQueue,
              args: [input()],
            });
            const pending = requestPushHandback(handle, request(await parked(handle)));
            try {
              await entered.promise;
              await handle.cancel();
              const receipt = await pending;
              expect(receipt).toMatchObject({ outcome: 'unknown', code: 'cancelled' });
              expect(receipt.acceptedContract).toEqual(stage === 'accepted-round' ? h1.contract : undefined);
              expect((await handle.query<TaskStatus>('taskStatus')).contract).toEqual(
                stage === 'accepted-round' ? h1.contract : h0.contract,
              );
            } finally {
              release.resolve();
            }
            await expect(handle.result()).rejects.toThrow();
            expect((await handle.describe()).status.name).toBe('CANCELLED');
            expect(calls.segment).toHaveLength(1);
            expect(calls.resume).toHaveLength(0);
            expect(w.count('pushBranch')).toBe(1);
            expect(reads).toBe(2);
            // 本例隔离 Workflow.cancel；cache0/换 worker 的兼容性由固定原历史和独立真重启证据验证。
          },
          { tasks },
        );
      } finally {
        await env.teardown();
      }
    },
  );
  it('wrong H0 and exhausted original budget cannot wake or grant a new observation', async () => {
    const env = environment(),
      w = world(),
      { tasks, calls } = scripted({ brief: () => ({ ok: true, brief: h0 }) });
    let reads = 0;
    tasks.readPushHandbackPreflight = async () => {
      reads++;
      return { outcome: 'budget-held', code: 'token_budget' };
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const handle = await env.client.workflow.start('taskWorkflow', {
          workflowId: `contract-${randomUUID()}`,
          taskQueue,
          args: [input()],
        });
        const before = await parked(handle),
          r = request(before);
        expect(
          await requestPushHandback(handle, {
            ...r,
            requestId: 'wrong-original',
            originalContract: h2.contract,
          } as PushHandbackRequest),
        ).toMatchObject({ outcome: 'unknown', code: 'original_contract' });
        expect(reads).toBe(0);
        expect(await requestPushHandback(handle, r)).toMatchObject({
          outcome: 'budget-held',
          code: 'token_budget',
        });
        expect((await parked(handle)).closedIssueClose?.token).toEqual(before.closedIssueClose?.token);
        expect(calls.segment).toHaveLength(1);
        expect(reads).toBe(1);
        await abandon(handle);
      },
      { tasks, maxCachedWorkflows: 0 },
    );
  });
  it('another request is busy during final read; changed target under the same request is conflict', async () => {
    const env = environment(),
      w = world();
    let live = h0,
      reads = 0;
    const { tasks } = scripted({
      brief: () => ({ ok: true, brief: live }),
      contractBrief: () => ({ ok: true, brief: live }),
    });
    const entered = deferred<void>(),
      release = deferred<PushHandbackPreflight>();
    tasks.readPushHandbackPreflight = async () => {
      if (++reads === 1) return success();
      entered.resolve();
      return release.promise;
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const handle = await env.client.workflow.start('taskWorkflow', {
          workflowId: `contract-${randomUUID()}`,
          taskQueue,
          args: [input()],
        });
        const r = request(await parked(handle));
        live = h1;
        const result = requestPushHandback(handle, r);
        await entered.promise;
        expect(await requestPushHandback(handle, { ...r, requestId: 'competing-operation' })).toMatchObject({
          outcome: 'busy',
        });
        expect(
          await requestPushHandback(handle, { ...r, expectedContract: h2.contract } as PushHandbackRequest),
        ).toMatchObject({ outcome: 'conflict' });
        release.resolve(success());
        const receipt = await result;
        expect(receipt).toMatchObject({ outcome: 'handed_back', acceptedContract: h1.contract });
        expect(await requestPushHandback(handle, r)).toEqual(receipt);
        expect(reads).toBe(2);
        await abandon(handle);
      },
      { tasks, maxCachedWorkflows: 0 },
    );
  });
  it('unreadable H2 after accepted snapshot holds before any new or resumed session', async () => {
    const env = environment(),
      w = world();
    let broken = false;
    const { tasks, calls } = scripted({
      brief: () => ({ ok: true, brief: h0 }),
      contractBrief: () =>
        broken
          ? { ok: false, problems: [{ field: '单子', why: 'new formal source unavailable' }] }
          : { ok: true, brief: h0 },
      resume: () => ({ kind: 'resume', runId: 'old-run', sessionId: 'must-not-resume' }),
    });
    tasks.readPushHandbackPreflight = async () => success();
    w.ports.recordRound = async () => {
      broken = true;
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const handle = await env.client.workflow.start('taskWorkflow', {
          workflowId: `contract-${randomUUID()}`,
          taskQueue,
          args: [input()],
        });
        const r = request(await parked(handle));
        expect(await requestPushHandback(handle, r)).toMatchObject({
          outcome: 'handed_back',
          acceptedContract: h1.contract,
        });
        const guarded = await pollQuery(
          () => handle.query<TaskStatus>('taskStatus'),
          (s) => s.phase === 'parked' && s.lastProblem === '单子的交代不全，没法动手',
          'new formal source safety boundary',
        );
        expect(guarded.contract).toEqual(h1.contract);
        expect(calls.segment).toHaveLength(1);
        expect(calls.resume).toHaveLength(0);
        await abandon(handle);
      },
      { tasks, maxCachedWorkflows: 0 },
    );
  });
  it.each(['failed-read', 'drift', 'wrong-snapshot'] as const)(
    'final %s leaves H0 and original hold untouched; explicit observed rejection is cached',
    async (failure) => {
      const env = environment(),
        w = world(),
        { tasks, calls } = scripted({ brief: () => ({ ok: true, brief: h0 }) });
      let reads = 0,
        rounds = 0;
      w.ports.recordRound = async () => {
        rounds++;
      };
      tasks.readPushHandbackPreflight = async () => {
        reads++;
        if (reads === 1) return success();
        if (failure === 'failed-read') throw new Error('source unreadable');
        if (failure === 'drift') return { outcome: 'unknown', code: 'contract' };
        return { ...success(), brief: h2 } as PushHandbackPreflight;
      };
      await withWorker(
        env,
        w,
        async (taskQueue) => {
          const handle = await env.client.workflow.start('taskWorkflow', {
            workflowId: `contract-${randomUUID()}`,
            taskQueue,
            args: [input()],
          });
          const before = await parked(handle),
            r = request(before);
          const receipt = await requestPushHandback(handle, r);
          expect(receipt.outcome).toBe('unknown');
          expect(receipt.acceptedContract).toBeUndefined();
          expect(await requestPushHandback(handle, r)).toEqual(receipt);
          const after = await parked(handle);
          expect(after.closedIssueClose?.token).toEqual(before.closedIssueClose?.token);
          expect(after.contract).toEqual(h0.contract);
          expect(after.round).toBe(before.round);
          expect(rounds).toBe(0);
          expect(calls.segment).toHaveLength(1);
          expect(w.count('pushBranch')).toBe(1);
          expect(reads).toBe(2);
          await abandon(handle);
        },
        { tasks, maxCachedWorkflows: 0 },
      );
    },
  );

  it('accepted snapshot waits for control consumption; H2 during round IO is read before the next segment', async () => {
    const env = environment(),
      w = world();
    let live = h0,
      reads = 0,
      settled = false;
    const { tasks, calls } = scripted({
      brief: () => ({ ok: true, brief: live }),
      contractBrief: () => ({ ok: true, brief: live }),
      resume: () => ({ kind: 'resume', runId: 'old-run', sessionId: 'must-not-resume' }),
    });
    const entered = deferred<void>(),
      release = deferred<void>();
    w.ports.recordRound = async () => {
      entered.resolve();
      await release.promise;
    };
    tasks.readPushHandbackPreflight = async () => {
      reads++;
      return success();
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const handle = await env.client.workflow.start('taskWorkflow', {
          workflowId: `contract-${randomUUID()}`,
          taskQueue,
          args: [input()],
        });
        const before = await parked(handle),
          r = request(before);
        live = h1;
        const result = requestPushHandback(handle, r).then((x) => {
          settled = true;
          return x;
        });
        await entered.promise;
        expect(settled).toBe(false);
        expect(calls.segment).toHaveLength(1);
        const accepted = await handle.query<TaskStatus>('taskStatus');
        expect(accepted.contract).toEqual(h1.contract);
        live = h2;
        release.resolve();
        const receipt = await result;
        expect(receipt).toMatchObject({ outcome: 'handed_back', acceptedContract: h1.contract });
        await waitUntil(() => calls.segment.length === 2, 'guarded second segment');
        expect(calls.segment[1]?.brief).toEqual(h2);
        expect(calls.segment[1]?.resumeSessionId).toBeUndefined();
        expect(calls.segment[1]?.feedback?.join('\n')).toContain('正式需求已修订');
        expect(await requestPushHandback(handle, r)).toEqual(receipt);
        expect(reads).toBe(2);
        expect(w.count('pushBranch')).toBe(1);
        await abandon(handle);
      },
      { tasks, maxCachedWorkflows: 0 },
    );
  });

  it.each(['continue', 'abandon'] as const)(
    '%s during final trusted observation never accepts a late snapshot',
    async (control) => {
      const env = environment(),
        w = world(),
        { tasks, calls } = scripted({ brief: () => ({ ok: true, brief: h0 }) });
      const entered = deferred<void>(),
        release = deferred<PushHandbackPreflight>();
      let reads = 0;
      tasks.readPushHandbackPreflight = async () => {
        if (++reads === 1) return success();
        entered.resolve();
        return release.promise;
      };
      await withWorker(
        env,
        w,
        async (taskQueue) => {
          const handle = await env.client.workflow.start('taskWorkflow', {
            workflowId: `contract-${randomUUID()}`,
            taskQueue,
            args: [input()],
          });
          const result = requestPushHandback(handle, request(await parked(handle)));
          await entered.promise;
          if (control === 'continue') await handle.signal(taskContinueSignal, { by: 'test' });
          else await handle.signal(taskAbandonSignal, { by: 'test', reason: 'during source IO' });
          release.resolve(success());
          const receipt = await result;
          expect(receipt.outcome).toBe('stale');
          expect(receipt.acceptedContract).toBeUndefined();
          expect(calls.segment).toHaveLength(1);
          if (control === 'continue') await abandon(handle);
          else expect(await handle.result()).toMatchObject({ outcome: 'abandoned' });
        },
        { tasks, maxCachedWorkflows: 0 },
      );
    },
  );

  it('abandon after snapshot acceptance preserves that fact but never reports control consumed', async () => {
    const env = environment(),
      w = world(),
      { tasks, calls } = scripted({ brief: () => ({ ok: true, brief: h0 }) });
    tasks.readPushHandbackPreflight = async () => success();
    const entered = deferred<void>(),
      release = deferred<void>();
    let rounds = 0;
    w.ports.recordRound = async () => {
      rounds++;
      entered.resolve();
      await release.promise;
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const handle = await env.client.workflow.start('taskWorkflow', {
          workflowId: `contract-${randomUUID()}`,
          taskQueue,
          args: [input()],
        });
        const r = request(await parked(handle)),
          result = requestPushHandback(handle, r);
        await entered.promise;
        await handle.signal(taskAbandonSignal, { by: 'test', reason: 'after accepted snapshot' });
        release.resolve();
        const receipt = await result;
        expect(receipt).toMatchObject({ outcome: 'stale', acceptedContract: h1.contract });
        expect(await handle.result()).toMatchObject({ outcome: 'abandoned' });
        expect(calls.segment).toHaveLength(1);
        expect(rounds).toBe(1);
      },
      { tasks, maxCachedWorkflows: 0 },
    );
  });

  it('existing best-effort round failure does not repeat acceptance, round recording or the request', async () => {
    const env = environment(),
      w = world();
    let live = h0,
      rounds = 0,
      reads = 0;
    const { tasks, calls } = scripted({
      brief: () => ({ ok: true, brief: live }),
      contractBrief: () => ({ ok: true, brief: live }),
    });
    tasks.readPushHandbackPreflight = async () => {
      reads++;
      return success();
    };
    w.ports.recordRound = async () => {
      rounds++;
      throw new PortError('ROUND_STATISTICS_UNAVAILABLE', 'explicit statistics failure', {
        retryable: false,
      });
    };
    await withWorker(
      env,
      w,
      async (taskQueue) => {
        const handle = await env.client.workflow.start('taskWorkflow', {
          workflowId: `contract-${randomUUID()}`,
          taskQueue,
          args: [input()],
        });
        const before = await parked(handle),
          r = request(before);
        live = h1;
        const receipt = await requestPushHandback(handle, r);
        expect(receipt).toMatchObject({ outcome: 'handed_back', acceptedContract: h1.contract });
        expect(await requestPushHandback(handle, r)).toEqual(receipt);
        await waitUntil(() => calls.segment.length === 2, 'normal next round despite statistics failure');
        expect(rounds).toBe(1);
        expect(reads).toBe(2);
        expect(calls.segment[1]?.brief).toEqual(h1);
        await abandon(handle);
      },
      { tasks, maxCachedWorkflows: 0 },
    );
  });
});
