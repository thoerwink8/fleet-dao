import { isObservedCheckoutSource } from '@fleet-dao/store';
import { temporal } from '@temporalio/proto';
import { describe, expect, it } from 'vitest';
import { ACCEPTANCE_HISTORY_LIMITS } from '../src/acceptance-execution-reader.ts';
import { type CheckoutExecutionIdentity, checkoutExecutionReader } from '../src/checkout-execution-reader.ts';
import { CHECKOUT_EXECUTION_ID, checkoutFixture, payload } from './checkout-execution-fixture.ts';

const id: CheckoutExecutionIdentity = {
  taskId: '00000000-0000-4000-8000-000000000001',
  repo: 'o/r',
  issueNumber: 1,
  workflowId: 'task:o/r#1',
  temporalRunId: CHECKOUT_EXECUTION_ID,
  prNumber: 2,
  head: 'f'.repeat(40),
  runId: '00000000-0000-4000-8000-000000000003',
  runStartedAt: '2026-10-18T21:05:32.381Z',
  runEndedAt: '2026-10-18T21:05:46.404Z',
};
type Fixture = ReturnType<typeof checkoutFixture>;
const event = (value: object) => temporal.api.history.v1.HistoryEvent.fromObject(value);
function sync(f: Fixture) {
  f.events.forEach((e, i) => {
    e.eventId = event({ eventId: String(i + 1) }).eventId;
  });
  f.description.workflowExecutionInfo!.historyLength = event({ eventId: String(f.events.length) }).eventId;
  f.pages[0]!.history!.events = f.events;
}
function addSecond(f: Fixture, head = id.head) {
  f.events.splice(
    4,
    0,
    event({
      ...f.events[1]!,
      activityTaskScheduledEventAttributes: {
        ...f.events[1]!.activityTaskScheduledEventAttributes!,
        input: payload({ taskId: id.taskId, repo: id.repo, issueNumber: 1, prNumber: 2, headSha: head }),
      },
    }),
    event({ ...f.events[2]!, activityTaskStartedEventAttributes: { scheduledEventId: '5', attempt: 1 } }),
    event({
      ...f.events[3]!,
      activityTaskCompletedEventAttributes: {
        scheduledEventId: '5',
        startedEventId: '6',
        result: payload({ pass: false }),
      },
    }),
  );
  sync(f);
}
describe('checkout 原 execution 唯一活动来源', () => {
  it('完整原execution里失败coldVerify可作来源，不借用最终pass；凭据不可改、不可序列化冒充', async () => {
    const f = checkoutFixture(id),
      result = await f.reader.read(id);
    expect(result.kind).toBe('observed');
    if (result.kind !== 'observed') throw Error('missing source');
    expect(result.proof).toMatchObject({
      runId: id.runId,
      executionRunId: id.temporalRunId,
      head: id.head,
      scheduled: '2',
      started: '3',
      completed: '4',
    });
    expect(Object.isFrozen(result.proof)).toBe(true);
    expect(isObservedCheckoutSource(result.proof)).toBe(true);
    expect(isObservedCheckoutSource(JSON.parse(JSON.stringify(result.proof)))).toBe(false);
  });
  it.each([
    ['wrong head', { head: 'a'.repeat(40) }],
    ['wrong PR', { prNumber: 3 }],
    ['wrong task', { taskId: 'other' }],
    ['wrong repo', { repo: 'x/r' }],
    ['wrong issue', { issueNumber: 2 }],
    ['wrong workflow', { workflowId: 'task:o/r#2' }],
    ['wrong execution', { temporalRunId: 'other' }],
    ['outside run', { runStartedAt: '2026-10-18T11:35:51.763Z', runEndedAt: '2026-10-18T11:36:11.408Z' }],
    ['reversed run', { runStartedAt: id.runEndedAt, runEndedAt: id.runStartedAt }],
  ])('%s 拒绝', async (_label, patch) => {
    expect((await checkoutFixture(id).reader.read({ ...id, ...patch })).kind).toBe('unknown');
  });
  it('真实旧head82e/后来head3ed形状：按原run区间选活动后核head，不能先筛同head', async () => {
    const f = checkoutFixture(id);
    addSecond(f, 'a'.repeat(40));
    // 第二个同PR活动在首报时间，只有它包住旧DBrun。
    for (const index of [4, 5])
      f.events[index]!.eventTime = event({
        eventTime: { seconds: String(Date.parse('2026-10-18T11:35:48.000Z') / 1000), nanos: 0 },
      }).eventTime!;
    f.events[6]!.eventTime = event({
      eventTime: { seconds: String(Date.parse('2026-10-18T11:36:20.000Z') / 1000), nanos: 0 },
    }).eventTime!;
    expect(
      (
        await f.reader.read({
          ...id,
          runStartedAt: '2026-10-18T11:35:51.763Z',
          runEndedAt: '2026-10-18T11:36:11.408Z',
        })
      ).kind,
    ).toBe('unknown');
  });
  const mutations: [string, (f: Fixture) => void][] = [
    [
      'missing started',
      (f) => {
        f.events[2]!.activityTaskStartedEventAttributes = null;
        f.events[2]!.eventType = 5;
      },
    ],
    [
      'wrong completed started ref',
      (f) => {
        f.events[3]!.activityTaskCompletedEventAttributes!.startedEventId = event({ eventId: '2' }).eventId;
      },
    ],
    [
      'wrong completed schedule ref',
      (f) => {
        f.events[3]!.activityTaskCompletedEventAttributes!.scheduledEventId = event({ eventId: '1' }).eventId;
      },
    ],
    [
      'wrong start schedule ref',
      (f) => {
        f.events[2]!.activityTaskStartedEventAttributes!.scheduledEventId = event({ eventId: '1' }).eventId;
      },
    ],
    [
      'retry attempt',
      (f) => {
        f.events[2]!.activityTaskStartedEventAttributes!.attempt = 2;
      },
    ],
    [
      'duplicate start',
      (f) => {
        f.events.splice(3, 0, event({ ...f.events[2]! }));
        sync(f);
      },
    ],
    ['overlap same head', (f) => addSecond(f)],
    ['overlap other head', (f) => addSecond(f, 'a'.repeat(40))],
    [
      'overlap uncompleted',
      (f) => {
        addSecond(f);
        f.events[6]!.activityTaskCompletedEventAttributes = null;
        f.events[6]!.eventType = 5;
      },
    ],
    ...(['failed', 'timedout', 'canceled'] as const).map((kind): [string, (f: Fixture) => void] => [
      `overlap ${kind}`,
      (f) => {
        addSecond(f);
        f.events[6]!.activityTaskCompletedEventAttributes = null;
        const key =
          kind === 'failed'
            ? 'activityTaskFailedEventAttributes'
            : kind === 'timedout'
              ? 'activityTaskTimedOutEventAttributes'
              : 'activityTaskCanceledEventAttributes';
        f.events[6]!.eventType = kind === 'failed' ? 13 : kind === 'timedout' ? 14 : 16;
        Object.assign(f.events[6]!, {
          [key]: {
            scheduledEventId: event({ eventId: '5' }).eventId,
            startedEventId: event({ eventId: '6' }).eventId,
          },
        });
      },
    ]),
    [
      'only scheduled interval contains run',
      (f) => {
        f.events[2]!.eventTime = f.events[3]!.eventTime!;
      },
    ],
    [
      'missing event time',
      (f) => {
        f.events[2]!.eventTime = null;
      },
    ],
    [
      'invalid activity time order',
      (f) => {
        f.events[3]!.eventTime = event({ eventTime: { seconds: '1' } }).eventTime!;
      },
    ],
    [
      'missing close',
      (f) => {
        f.events.pop();
        sync(f);
      },
    ],
    [
      'wrong close',
      (f) => {
        f.events[4]!.workflowExecutionCompletedEventAttributes = null;
        f.events[4]!.workflowExecutionFailedEventAttributes = {};
        f.events[4]!.eventType = 3;
      },
    ],
    [
      'after close',
      (f) => {
        f.events.push(event({ eventId: '6', eventType: 5 }));
        sync(f);
      },
    ],
    [
      'missing page',
      (f) => {
        f.events.splice(2, 1);
      },
    ],
    [
      'duplicate event',
      (f) => {
        f.events[2]!.eventId = f.events[1]!.eventId;
      },
    ],
    [
      'out of order',
      (f) => {
        [f.events[1], f.events[2]] = [f.events[2]!, f.events[1]!];
      },
    ],
    [
      'unfinished execution',
      (f) => {
        f.description.workflowExecutionInfo!.status = 1;
      },
    ],
    [
      'raw history',
      (f) => {
        f.pages[0]!.rawHistory = [{ data: Buffer.from('x') }];
      },
    ],
    [
      'archived',
      (f) => {
        f.pages[0]!.archived = true;
      },
    ],
    [
      'oversized token',
      (f) => {
        f.pages[0]!.nextPageToken = Buffer.alloc(ACCEPTANCE_HISTORY_LIMITS.tokenBytes + 1);
      },
    ],
    [
      'oversized payload',
      (f) => {
        f.events[1]!.activityTaskScheduledEventAttributes!.input!.payloads![0]!.data = Buffer.alloc(
          ACCEPTANCE_HISTORY_LIMITS.payloadBytes + 1,
        );
      },
    ],
  ];
  it.each(mutations)('%s 明确拒绝，不产生可信凭据', async (_label, mutate) => {
    const f = checkoutFixture(id);
    mutate(f);
    expect((await f.reader.read(id)).kind).toBe('unknown');
  });
  it('合法空页照同一token耗尽规则完整读取，不截掉后面的活动', async () => {
    const f = checkoutFixture(id);
    f.pages.unshift(
      temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse.create({
        history: { events: [] },
        nextPageToken: Buffer.from('next'),
      }),
    );
    expect((await f.reader.read(id)).kind).toBe('observed');
  });
  it('取消、超时、读取失败都明确unknown', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await checkoutFixture(id).reader.read(id, controller.signal)).toMatchObject({
      kind: 'unknown',
      code: 'cancelled',
    });
    const f = checkoutFixture(id);
    f.connection.workflowService.getWorkflowExecutionHistory.mockRejectedValue(new Error('unavailable'));
    expect(await f.reader.read(id)).toMatchObject({ kind: 'unknown', code: 'read_failed' });
    expect(await checkoutExecutionReader(f.connection as never, 'test', 0).read(id)).toMatchObject({
      kind: 'unknown',
      code: 'deadline',
    });
  });
});
