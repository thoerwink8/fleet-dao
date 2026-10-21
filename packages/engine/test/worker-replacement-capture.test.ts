import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import { Worker } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineBundle } from './support.ts';

// #3413：原用例「same run reconstructs…」本机一次 60 秒超时的 watchdog 取证。
// 阶段 first-worker:parked-query。workflow / run 写在同目录 identity.capture（原样一行，不进格式化）。
// 不是 CI run 39392992046（那次没留历史），也不是 abandon-buffered-3413 的两份，
// 也不是 push-handback-contract 的 park-kind run。字节保持取证当时的 protobuf / describe，不许重录覆盖。
const directory = fileURLToPath(new URL('./replay/worker-replacement-3413/', import.meta.url));
const HISTORY_SHA256 = '6631d578fbdfd6237721ba8d93508c415707c3fbcdfc670b24b6738fcdd43f48';
const DESCRIBE_SHA256 = 'c55f4f9d7c4513d129b30422956be262894a9248a547900b5b0ab4c5e3c3942b';
const IDENTITY_SHA256 = 'b525a892c762d8dc8219d50ad99562e3417953fbaa2ae272acdb2f6ac457bc51';
const WORKFLOW_ID = 'handback-0c8f4322-17be-4b14-9e92-c81f0514e949';
const RUN_ID = '6385a827-f825-4d12-8bd9-d3e2351b6db6';

type Event = {
  eventId?: string | number;
  markerRecordedEventAttributes?: {
    markerName?: string;
    details?: { 'patch-data'?: { payloads?: { data?: string | Uint8Array }[] } };
  } | null;
  activityTaskScheduledEventAttributes?: { activityType?: { name?: string } } | null;
  activityTaskStartedEventAttributes?: { scheduledEventId?: string | number } | null;
  activityTaskCompletedEventAttributes?: { scheduledEventId?: string | number } | null;
  workflowTaskFailedEventAttributes?: { failure?: { message?: string } | null } | null;
  workflowTaskTimedOutEventAttributes?: object | null;
  workflowTaskStartedEventAttributes?: object | null;
  workflowExecutionSignaledEventAttributes?: { signalName?: string } | null;
  workflowExecutionCompletedEventAttributes?: object | null;
};

const requireFromCommon = createRequire(
  fileURLToPath(import.meta.resolve('@temporalio/common/lib/proto-utils.js')),
);
const History = (
  requireFromCommon('@temporalio/proto') as {
    temporal: { api: { history: { v1: { History: { decode(bytes: Uint8Array): { events?: Event[] } } } } } };
  }
).temporal.api.history.v1.History;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function patchId(event: Event): string | undefined {
  const data = event.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0]?.data;
  if (data === undefined) return undefined;
  const bytes =
    typeof data === 'string'
      ? Buffer.from(data, data.startsWith('{') ? 'utf8' : 'base64')
      : Buffer.from(data);
  const json = JSON.parse(bytes.toString('utf8')) as { id?: string };
  return json.id;
}

let bundle: Awaited<ReturnType<typeof engineBundle>>;
beforeAll(async () => {
  bundle = await engineBundle();
}, 120_000);

describe('#3413 原用例停在查停点的取证', () => {
  it('watchdog 绑这条 run：readTaskBrief 之后 self-check-own-timeout 的工作流任务失败，随后任务超时', () => {
    const historyBytes = readFileSync(`${directory}park-query-timeout.history.bin`);
    const describeBytes = readFileSync(`${directory}park-query-timeout.describe.bin`);
    const identityBytes = readFileSync(`${directory}identity.capture`);
    expect(sha256(identityBytes)).toBe(IDENTITY_SHA256);
    const identity = JSON.parse(identityBytes.toString('utf8')) as {
      test: string;
      workflowId: string;
      runId: string;
      stage: string;
      reason: string;
      sha256: string;
      kind: string;
    };
    expect(sha256(historyBytes)).toBe(HISTORY_SHA256);
    expect(sha256(describeBytes)).toBe(DESCRIBE_SHA256);
    expect(identity).toMatchObject({
      test: 'same run reconstructs business receipts after worker replacement, then accepts one new request',
      workflowId: WORKFLOW_ID,
      runId: RUN_ID,
      stage: 'first-worker:parked-query',
      reason: 'watchdog',
      kind: 'history',
      sha256: HISTORY_SHA256,
    });
    const described = JSON.parse(describeBytes.toString('utf8')) as {
      workflowId: string;
      runId: string;
      status: { name: string };
      historyLength: number;
      pendingActivityCount: number;
      pendingActivities: unknown[];
    };
    expect(described).toEqual({
      workflowId: WORKFLOW_ID,
      runId: RUN_ID,
      status: { code: 1, name: 'RUNNING' },
      historyLength: 30,
      pendingActivityCount: 0,
      pendingActivitiesTruncated: false,
      pendingActivities: [],
    });

    const events = History.decode(historyBytes).events ?? [];
    expect(events).toHaveLength(30);
    const marker = events.find((event) => event.markerRecordedEventAttributes?.markerName === 'core_patch');
    expect(patchId(marker ?? {})).toBe('self-check-own-timeout');
    const scheduled = events.find((event) => event.activityTaskScheduledEventAttributes);
    expect(scheduled?.activityTaskScheduledEventAttributes?.activityType?.name).toBe('readTaskBrief');
    const scheduledId = String(scheduled?.eventId);
    expect(
      events.some(
        (event) => String(event.activityTaskStartedEventAttributes?.scheduledEventId) === scheduledId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => String(event.activityTaskCompletedEventAttributes?.scheduledEventId) === scheduledId,
      ),
    ).toBe(true);
    const failed = events.find((event) => event.workflowTaskFailedEventAttributes);
    expect(failed?.workflowTaskFailedEventAttributes?.failure?.message).toContain(
      '[TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered for change self-check-own-timeout, but there is no corresponding change command!',
    );
    const failedAt = events.indexOf(failed ?? {});
    expect(failedAt).toBeGreaterThan(events.indexOf(scheduled ?? {}));
    const after = events.slice(failedAt + 1);
    expect(after.filter((event) => event.workflowTaskTimedOutEventAttributes)).toHaveLength(4);
    expect(events.at(-1)?.workflowTaskStartedEventAttributes).toBeTruthy();
    expect(events.some((event) => event.workflowExecutionCompletedEventAttributes)).toBe(false);
    expect(events.some((event) => event.workflowExecutionSignaledEventAttributes)).toBe(false);
  });

  // 机制见 la-query-split.test.ts：第一个工作流任务只交了本地活动标记，同一毫秒强开新任务，补丁标记落在新任务里。
  // 不是心跳强开：第一个任务从开到交不到 1 秒，心跳要到工作流任务超时 10 秒的 80%。那时用例在轮询停点查询。
  it('原字节的形状：本地活动结果被强开的新任务隔开，补丁标记不在本地活动标记那个任务里', () => {
    const events = History.decode(readFileSync(`${directory}park-query-timeout.history.bin`)).events ?? [];
    const json = JSON.parse(historyToJSON({ events } as unknown as Parameters<typeof historyToJSON>[0])) as {
      events: ({ eventId: string; eventTime: string; eventType: string } & Record<string, unknown>)[];
    };
    const view = json.events.map(({ eventId, eventTime, eventType }) => ({ eventId, eventTime, eventType }));
    expect(view.slice(1, 9)).toEqual([
      {
        eventId: '2',
        eventTime: '2026-10-20T14:22:00.686Z',
        eventType: 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED',
      },
      { eventId: '3', eventTime: '2026-10-20T14:22:00.880Z', eventType: 'EVENT_TYPE_WORKFLOW_TASK_STARTED' },
      {
        eventId: '4',
        eventTime: '2026-10-20T14:22:01.179Z',
        eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
      },
      { eventId: '5', eventTime: '2026-10-20T14:22:01.179Z', eventType: 'EVENT_TYPE_MARKER_RECORDED' },
      {
        eventId: '6',
        eventTime: '2026-10-20T14:22:01.179Z',
        eventType: 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED',
      },
      { eventId: '7', eventTime: '2026-10-20T14:22:01.182Z', eventType: 'EVENT_TYPE_WORKFLOW_TASK_STARTED' },
      {
        eventId: '8',
        eventTime: '2026-10-20T14:22:01.241Z',
        eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
      },
      { eventId: '9', eventTime: '2026-10-20T14:22:01.241Z', eventType: 'EVENT_TYPE_MARKER_RECORDED' },
    ]);
    expect(
      (json.events[0]?.workflowExecutionStartedEventAttributes as { workflowTaskTimeout?: string })
        ?.workflowTaskTimeout,
    ).toBe('10s');
    expect(events[4]?.markerRecordedEventAttributes?.markerName).toBe('core_local_activity');
    expect(events[8]?.markerRecordedEventAttributes?.markerName).toBe('core_patch');
    expect(patchId(events[8] ?? {})).toBe('self-check-own-timeout');
  });

  // 钉的是现在的代码对不上这份原字节，不是修复。不改 kit.ts（那条标记归 #3258）。
  // 若那边的改动让同一份字节重放通过，改这条断言，不许重录覆盖。
  it('现在的代码离线重放这份原字节仍报 self-check-own-timeout 的 TMPRL1100', async () => {
    const decoded = History.decode(readFileSync(`${directory}park-query-timeout.history.bin`));
    const error = await Worker.runReplayHistory(
      { workflowBundle: bundle },
      JSON.parse(historyToJSON(decoded as unknown as Parameters<typeof historyToJSON>[0])),
      WORKFLOW_ID,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeterminismViolationError);
    expect(String((error as Error).message)).toContain(
      '[TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered for change self-check-own-timeout, but there is no corresponding change command!',
    );
  });
});

// 第二份，另一种卡法：本机四个测试文件并行时原用例在同一处（first-worker:parked-query）20 秒超时，失败取证。
// 测试文件是 a6c77390 那版（testSha256 对得上），还是从起头每 50 毫秒查一次。没有失败、超时事件，
// 工作流一直在走，只是 cache0 下每个任务和每次查询都整段重放，20 秒只走到 implement 的 selfCheck。
// 和上面那份不是一个机制，也不替换它。
describe('#3413 原用例负载下查停点 20 秒超时的失败取证（无失败事件，走得慢）', () => {
  const SLOW_HISTORY_SHA256 = 'b777f32758f9f171d381a3a77852c1610f631899a54c0aecea3a7bcfbdb94204';
  const SLOW_DESCRIBE_SHA256 = '77c9d1b1467108474c338bc495ffddd5e82cfa2977af3eb872557eaa469115bb';
  const SLOW_IDENTITY_SHA256 = '15163c4ab47dbc49cfcd1aae8e5e09d7ca04887838ac69c3015ecc2188141403';
  const SLOW_WORKFLOW_ID = 'handback-219c330f-2d51-4859-8c87-780843328926';
  const SLOW_RUN_ID = 'd8500003-6fa1-44b5-8530-cb27b667ff2b';

  it('绑这条 run：186 个事件全无失败或超时，最后在 selfCheck 之后等下一个工作流任务；现在的代码重放得过', async () => {
    const historyBytes = readFileSync(`${directory}slow-parked-query.history.bin`);
    const describeBytes = readFileSync(`${directory}slow-parked-query.describe.bin`);
    const identityBytes = readFileSync(`${directory}slow-parked-query.identity.capture`);
    expect(sha256(historyBytes)).toBe(SLOW_HISTORY_SHA256);
    expect(sha256(describeBytes)).toBe(SLOW_DESCRIBE_SHA256);
    expect(sha256(identityBytes)).toBe(SLOW_IDENTITY_SHA256);
    expect(JSON.parse(identityBytes.toString('utf8'))).toMatchObject({
      test: 'same run reconstructs business receipts after worker replacement, then accepts one new request',
      workflowId: SLOW_WORKFLOW_ID,
      runId: SLOW_RUN_ID,
      testSha256: 'c754d8617fc51f8dab4d6e4e84507f23e0dc001987cb34b9f51045aa5f952543',
      stage: 'wait:first-worker:parked-query',
      reason: 'test-body-failed',
      kind: 'history',
      sha256: SLOW_HISTORY_SHA256,
    });
    expect(JSON.parse(describeBytes.toString('utf8'))).toEqual({
      workflowId: SLOW_WORKFLOW_ID,
      runId: SLOW_RUN_ID,
      status: { code: 1, name: 'RUNNING' },
      historyLength: 186,
      pendingActivityCount: 0,
      pendingActivitiesTruncated: false,
      pendingActivities: [],
    });
    const decoded = History.decode(historyBytes);
    const events = decoded.events ?? [];
    expect(events).toHaveLength(186);
    expect(events.some((event) => event.workflowTaskFailedEventAttributes)).toBe(false);
    expect(events.some((event) => event.workflowTaskTimedOutEventAttributes)).toBe(false);
    expect(events.some((event) => event.workflowExecutionSignaledEventAttributes)).toBe(false);
    const scheduled = events.filter((event) => event.activityTaskScheduledEventAttributes);
    expect(scheduled.at(-1)?.activityTaskScheduledEventAttributes?.activityType?.name).toBe('selfCheck');
    expect(events.at(-1)?.workflowTaskStartedEventAttributes).toBeTruthy();
    await Worker.runReplayHistory(
      { workflowBundle: bundle },
      JSON.parse(historyToJSON(decoded as unknown as Parameters<typeof historyToJSON>[0])),
      SLOW_WORKFLOW_ID,
    );
  });
});
