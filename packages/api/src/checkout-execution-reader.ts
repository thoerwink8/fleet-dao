import { type CheckoutSource, observedCheckoutSource } from '@fleet-dao/store';
import type { temporal as Temporal } from '@temporalio/proto';
import {
  type AcceptanceExecutionIdentity,
  boundedExecutionReader,
  type ExecutionInterpreter,
  type ExecutionReader,
  executionFailure,
  executionPayload,
  type HistoryConnection,
  openExecutionReader,
} from './acceptance-execution-reader.ts';

export interface CheckoutExecutionIdentity extends AcceptanceExecutionIdentity {
  runId: string;
  runStartedAt: string;
  runEndedAt: string;
}
export type CheckoutExecutionReader = ExecutionReader<CheckoutSource, CheckoutExecutionIdentity>;
type Event = Temporal.api.history.v1.IHistoryEvent;
const ns = (
  time:
    | { seconds?: { toString(): string } | number | string | null; nanos?: number | null }
    | null
    | undefined,
): bigint => {
  if (
    !time?.seconds ||
    !Number.isInteger(time.nanos ?? 0) ||
    (time.nanos ?? 0) < 0 ||
    (time.nanos ?? 0) >= 1e9
  )
    return executionFailure('activity_time_missing');
  return BigInt(time.seconds.toString()) * 1_000_000_000n + BigInt(time.nanos ?? 0);
};
const iso = (value: bigint): string =>
  `${new Date(Number(value / 1_000_000_000n) * 1000).toISOString().slice(0, 19)}.${(value % 1_000_000_000n).toString().padStart(9, '0')}Z`;
function interpreter(id: CheckoutExecutionIdentity): ExecutionInterpreter<CheckoutSource> {
  const from = Date.parse(id.runStartedAt),
    to = Date.parse(id.runEndedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || !id.runId)
    executionFailure('invalid_context');
  const begin = BigInt(from) * 1_000_000n,
    end = BigInt(to) * 1_000_000n;
  const activities = new Map<
    string,
    {
      scheduled: string;
      scheduledAt: bigint;
      inputHash: string;
      pr: number;
      head: string;
      started?: string;
      startedAt?: bigint;
      terminal?: string;
      terminalAt?: bigint;
      completed?: string;
      completedAt?: bigint;
      resultHash?: string;
    }
  >();
  return {
    event(event: Event, check) {
      check();
      const eventId = event.eventId?.toString() ?? '';
      const schedule = event.activityTaskScheduledEventAttributes;
      if (schedule?.activityType?.name === 'coldVerify') {
        if (event.eventType !== 10) executionFailure('malformed_history');
        const decoded = executionPayload(schedule.input),
          value = decoded.value;
        const repo =
          typeof value.repo === 'string'
            ? value.repo
            : value.repo && typeof value.repo === 'object'
              ? `${(value.repo as Record<string, unknown>).owner}/${(value.repo as Record<string, unknown>).name}`
              : '';
        if (
          value.taskId !== id.taskId ||
          repo !== id.repo ||
          value.issueNumber !== id.issueNumber ||
          !Number.isSafeInteger(value.prNumber) ||
          typeof value.headSha !== 'string' ||
          !/^[0-9a-f]{40}$/.test(value.headSha)
        )
          executionFailure('identity_conflict');
        activities.set(eventId, {
          scheduled: eventId,
          scheduledAt: ns(event.eventTime),
          inputHash: decoded.hash,
          pr: value.prNumber as number,
          head: value.headSha as string,
        });
      }
      const start = event.activityTaskStartedEventAttributes;
      if (start) {
        const activity = activities.get(start.scheduledEventId?.toString() ?? '');
        if (activity) {
          if (event.eventType !== 11 || activity.started || activity.terminal || (start.attempt ?? 1) !== 1)
            executionFailure('ambiguous_activity');
          activity.started = eventId;
          activity.startedAt = ns(event.eventTime);
          if (activity.startedAt < activity.scheduledAt) executionFailure('activity_time_conflict');
        }
      }
      const complete = event.activityTaskCompletedEventAttributes;
      if (complete) {
        const activity = activities.get(complete.scheduledEventId?.toString() ?? '');
        if (activity) {
          if (
            event.eventType !== 12 ||
            !activity.started ||
            activity.terminal ||
            complete.startedEventId?.toString() !== activity.started
          )
            executionFailure('ambiguous_activity');
          activity.completed = eventId;
          activity.completedAt = ns(event.eventTime);
          activity.terminal = eventId;
          activity.terminalAt = activity.completedAt;
          if (activity.completedAt < activity.startedAt!) executionFailure('activity_time_conflict');
          activity.resultHash = executionPayload(complete.result).hash;
        }
      }
      for (const [kind, type] of [
        [event.activityTaskFailedEventAttributes, 13],
        [event.activityTaskTimedOutEventAttributes, 14],
        [event.activityTaskCanceledEventAttributes, 16],
      ] as const) {
        if (!kind) continue;
        const activity = activities.get(kind.scheduledEventId?.toString() ?? '');
        if (!activity) continue;
        const startedId = kind.startedEventId?.toString() ?? '0';
        if (event.eventType !== type || activity.terminal || (activity.started ?? '0') !== startedId)
          executionFailure('ambiguous_activity');
        activity.terminal = eventId;
        activity.terminalAt = ns(event.eventTime);
        if (activity.terminalAt < (activity.startedAt ?? activity.scheduledAt))
          executionFailure('activity_time_conflict');
      }
    },
    finish(context) {
      // Match the DB run before head filtering: a different head or overlapping activities cannot be hidden.
      const overlapping = [...activities.values()].filter(
        (a) => (a.startedAt ?? a.scheduledAt) <= end && (a.terminalAt === undefined || begin <= a.terminalAt),
      );
      const matched = overlapping.filter(
        (a) =>
          a.startedAt !== undefined &&
          a.completedAt !== undefined &&
          a.startedAt <= begin &&
          end <= a.completedAt,
      );
      if (overlapping.length !== 1 || matched.length !== 1) executionFailure('run_activity_conflict');
      const activity = matched[0]!;
      if (activity.head !== id.head || activity.pr !== id.prNumber) executionFailure('run_head_conflict');
      return observedCheckoutSource({
        namespace: context.namespace,
        workflowId: id.workflowId,
        executionRunId: id.temporalRunId,
        taskId: id.taskId,
        repo: id.repo,
        issueNumber: id.issueNumber,
        pr: id.prNumber,
        head: id.head,
        runId: id.runId,
        runStartedAt: id.runStartedAt,
        runEndedAt: id.runEndedAt,
        scheduled: activity.scheduled,
        started: activity.started!,
        completed: activity.completed!,
        scheduledAt: iso(activity.scheduledAt),
        startedAt: iso(activity.startedAt!),
        completedAt: iso(activity.completedAt!),
        inputHash: activity.inputHash,
        resultHash: activity.resultHash!,
        startHash: context.startHash,
        closeEvent: context.closeEvent,
      });
    },
  };
}
export function checkoutExecutionReader(
  connection: HistoryConnection,
  namespace: string,
  remainingMs?: number,
): CheckoutExecutionReader {
  return boundedExecutionReader(connection, namespace, interpreter, remainingMs);
}
export const openCheckoutExecutionReader = (
  env: Record<string, string | undefined>,
): CheckoutExecutionReader => openExecutionReader(env, checkoutExecutionReader);
