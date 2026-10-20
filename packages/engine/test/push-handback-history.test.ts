import { defaultPayloadConverter } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import type { PushHandbackPreflightInput } from '../src/push-handback.ts';
import { naturalPushHistory } from '../src/real/push-handback-history.ts';

type Event = Parameters<typeof naturalPushHistory>[0][number];
const payload = (value: unknown) => ({ payloads: [defaultPayloadConverter.toPayload(value)!] });
const input: PushHandbackPreflightInput = {
  version: 1,
  workflowId: 'task:acme/demo#3343',
  runId: '01a155b5-0f4b-7905-b9f7-8c82eb9e4bc9',
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
  token: {
    version: 1,
    runId: '01a155b5-0f4b-7905-b9f7-8c82eb9e4bc9',
    kind: 'parked',
    generation: 1,
    continued: 0,
  },
  budgetGrants: 1,
  taskTokenBudget: 1000,
  round: 1,
  verifyRound: 0,
};

function fixture() {
  const rows: Record<string, unknown>[] = [];
  function add(attributes: Record<string, unknown>) {
    const n = rows.length + 1;
    rows.push({
      eventId: { toString: () => String(n) },
      eventTime: { seconds: { toString: () => '1700000000' }, nanos: 0 },
      ...attributes,
    });
    return String(n);
  }
  add({
    workflowExecutionStartedEventAttributes: {
      workflowType: { name: 'taskWorkflow' },
      taskQueue: { name: 'fleet' },
      input: payload(input.task),
    },
  });
  function activity(name: string, args: unknown, result: unknown, failed = false) {
    const id = add({
      activityTaskScheduledEventAttributes: {
        activityType: { name },
        activityId: name,
        input: payload(args),
      },
    });
    const scheduledEventId = { toString: () => id };
    const start = add({
      activityTaskStartedEventAttributes: { scheduledEventId, attempt: 1, identity: '4864@fixture' },
    });
    const startedEventId = { toString: () => start };
    add(
      failed
        ? {
            activityTaskFailedEventAttributes: {
              scheduledEventId,
              startedEventId,
              failure: { applicationFailureInfo: { type: 'WORKFLOWS_PERMISSION' } },
            },
          }
        : {
            activityTaskCompletedEventAttributes: {
              scheduledEventId,
              startedEventId,
              result: payload(result),
            },
          },
    );
  }
  activity(
    'runSegment',
    { taskId: input.task.taskId, worktreePath: input.path, branch: input.branch },
    { ok: true, runId: '89b8928a-6a0c-4dfc-8ae7-0154a1644a94' },
  );
  activity(
    'pushBranch',
    {
      repo: input.task.repo,
      taskId: input.task.taskId,
      worktreePath: input.path,
      branch: input.branch,
      head: 'a'.repeat(40),
    },
    null,
    true,
  );
  activity('saveTaskState', { taskId: input.task.taskId }, {});
  activity('raiseAlert', { taskId: input.task.taskId }, {});
  add({
    activityTaskScheduledEventAttributes: {
      activityId: 'current',
      activityType: { name: 'readPushHandbackPreflight' },
      input: payload(input),
    },
  });
  return { rows, add, activity, events: rows as unknown as Event[] };
}

describe('natural permission-push complete history identity', () => {
  it('v2 managed observations are recognized without allowing ordinary post-failure activities', () => {
    const f = fixture();
    const revised: PushHandbackPreflightInput = {
      ...input,
      version: 2,
      requestId: 'fixed-operation',
      expectedContract: { version: 1, sha256: 'f'.repeat(64) },
    };
    (f.rows.at(-1)!.activityTaskScheduledEventAttributes as Record<string, unknown>).input = payload(revised);
    expect(naturalPushHistory(f.events, revised, 'current', 'fleet').failedHead).toBe('a'.repeat(40));
    expect(() =>
      naturalPushHistory(f.events, { ...revised, expectedContract: input.contract }, 'current', 'fleet'),
    ).toThrow('history_preflight_identity');
    f.activity('readTaskBrief', { taskId: input.task.taskId, checkContract: true }, { ok: true });
    expect(() => naturalPushHistory(f.events, revised, 'current', 'fleet')).toThrow(
      'history_actor_after_failed_push',
    );
  });
  it('accepts exact natural shape including post-failure bookkeeping and separate read-only actor', () => {
    const f = fixture(),
      r = naturalPushHistory(f.events, input, 'current', 'fleet');
    expect(r.worker).toBe('4864@fixture');
    expect(r.failedHead).toBe('a'.repeat(40));
    expect(r.runIds).toHaveLength(1);
    expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(naturalPushHistory(f.events, input, undefined, 'fleet').worker).toBe(r.worker);
  });
  it.each([
    'retry',
    'cancel',
    'timeout',
    'missing-terminal',
    'foreign-worker',
    'attached',
    'extra-actor',
    'signal',
    'incomplete',
    'queue',
    'preflight',
    'wrong-started-id',
    'terminal-before-start',
    'invalid-utf8',
  ] as const)('rejects %s without a synthesized retirement', (kind) => {
    const f = fixture();
    const start = f.rows[2]!.activityTaskStartedEventAttributes as Record<string, unknown>;
    if (kind === 'retry') start.attempt = 2;
    if (kind === 'wrong-started-id')
      (f.rows[3]!.activityTaskCompletedEventAttributes as Record<string, unknown>).startedEventId = {
        toString: () => '2',
      };
    if (kind === 'terminal-before-start')
      f.rows[3]!.eventTime = { seconds: { toString: () => '1699999999' }, nanos: 0 };
    if (kind === 'invalid-utf8') {
      const p = payload(input.task);
      p.payloads[0]!.data = Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
      (f.rows[0]!.workflowExecutionStartedEventAttributes as Record<string, unknown>).input = p;
    }
    if (kind === 'cancel' || kind === 'timeout')
      f.rows[3] = {
        [kind === 'cancel' ? 'activityTaskCanceledEventAttributes' : 'activityTaskTimedOutEventAttributes']: {
          scheduledEventId: { toString: () => '2' },
        },
        eventId: { toString: () => '4' },
      };
    if (kind === 'missing-terminal') delete f.rows[3]!.activityTaskCompletedEventAttributes;
    if (kind === 'foreign-worker') start.identity = '1234@different';
    if (kind === 'attached')
      (f.rows[1]!.activityTaskScheduledEventAttributes as Record<string, unknown>).input = payload({
        taskId: input.task.taskId,
        worktreePath: input.path,
        branch: input.branch,
        attach: { runId: 'old' },
      });
    if (kind === 'extra-actor') f.activity('runSegment', {}, { ok: true });
    if (kind === 'signal')
      f.add({ workflowExecutionSignaledEventAttributes: { signalName: 'taskContinue' } });
    if (kind === 'incomplete') f.rows[2]!.eventId = { toString: () => '500' };
    if (kind === 'queue')
      (f.rows[0]!.workflowExecutionStartedEventAttributes as Record<string, unknown>).taskQueue = {
        name: 'foreign',
      };
    if (kind === 'preflight')
      (f.rows.at(-1)!.activityTaskScheduledEventAttributes as Record<string, unknown>).input = payload({
        ...input,
        budgetGrants: 2,
      });
    expect(() => naturalPushHistory(f.events, input, 'current', 'fleet')).toThrow();
  });
});
