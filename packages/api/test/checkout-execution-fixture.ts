import type { Connection } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { vi } from 'vitest';
import { ACCEPTANCE_HISTORY_LIMITS } from '../src/acceptance-execution-reader.ts';
import { type CheckoutExecutionIdentity, checkoutExecutionReader } from '../src/checkout-execution-reader.ts';

export const CHECKOUT_EXECUTION_ID = '00000000-0000-4000-8000-000000000002';
export const payload = (v: unknown) => ({
  payloads: [{ metadata: { encoding: Buffer.from('json/plain') }, data: Buffer.from(JSON.stringify(v)) }],
});
export function checkoutFixture(id: CheckoutExecutionIdentity) {
  const identity = { taskId: id.taskId, repo: id.repo, issueNumber: id.issueNumber };
  const at = (time: string) => ({
    seconds: Math.floor(Date.parse(time) / 1000),
    nanos: (Date.parse(time) % 1000) * 1e6,
  });
  const begin = new Date(Date.parse(id.runStartedAt) - 1000).toISOString();
  const finish = new Date(Date.parse(id.runEndedAt) + 1000).toISOString();
  const events = [
    {
      eventType: 1,
      eventTime: at(begin),
      workflowExecutionStartedEventAttributes: {
        workflowType: { name: 'taskWorkflow' },
        taskQueue: { name: 'q' },
        input: payload(identity),
      },
    },
    {
      eventType: 10,
      eventTime: at(begin),
      activityTaskScheduledEventAttributes: {
        activityType: { name: 'coldVerify' },
        input: payload({ ...identity, prNumber: id.prNumber, headSha: id.head }),
      },
    },
    {
      eventType: 11,
      eventTime: at(begin),
      activityTaskStartedEventAttributes: { scheduledEventId: '2', attempt: 1 },
    },
    {
      eventType: 12,
      eventTime: at(finish),
      activityTaskCompletedEventAttributes: {
        scheduledEventId: '2',
        startedEventId: '3',
        result: payload({ pass: false }),
      },
    },
    { eventType: 2, eventTime: at(finish), workflowExecutionCompletedEventAttributes: {} },
  ].map((event, i) => temporal.api.history.v1.HistoryEvent.fromObject({ ...event, eventId: String(i + 1) }));
  const description = temporal.api.workflowservice.v1.DescribeWorkflowExecutionResponse.fromObject({
    workflowExecutionInfo: {
      execution: { workflowId: id.workflowId, runId: id.temporalRunId },
      status: 2,
      historyLength: String(events.length),
      closeTime: at(finish),
      type: { name: 'taskWorkflow' },
    },
    executionConfig: { taskQueue: { name: 'q' } },
  });
  const pages = [
    temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse.create({ history: { events } }),
  ];
  let page = 0;
  const connection = {
    options: { channelArgs: { 'grpc.max_receive_message_length': ACCEPTANCE_HISTORY_LIMITS.responseBytes } },
    withDeadline: async (_: number, fn: () => Promise<unknown>) => fn(),
    withAbortSignal: async (_: AbortSignal, fn: () => Promise<unknown>) => fn(),
    workflowService: {
      describeWorkflowExecution: vi.fn(async () => description),
      getWorkflowExecutionHistory: vi.fn(async () => pages[page++]!),
    },
  };
  return {
    events,
    description,
    pages,
    connection,
    reader: checkoutExecutionReader(connection as unknown as Connection, 'test'),
  };
}
