import { createHash } from 'node:crypto';
import type { Connection } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import type { PushHandbackPreflightInput } from '../push-handback.ts';

type Response = Awaited<ReturnType<Connection['workflowService']['getWorkflowExecutionHistory']>>;
type Event = NonNullable<NonNullable<Response['history']>['events']>[number];

export interface NaturalPushHistory {
  worker: string;
  runIds: string[];
  sinceMs: number;
  failedHead: string;
  sha256: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(row[k])}`)
    .join(',')}}`;
}

function decode(
  payloads:
    | {
        payloads?:
          | readonly { data?: Uint8Array | null; metadata?: Record<string, Uint8Array> | null }[]
          | null;
      }
    | null
    | undefined,
): Record<string, unknown> {
  const p = payloads?.payloads;
  if (
    p?.length !== 1 ||
    !p[0]?.data ||
    p[0].data.byteLength > 256 * 1024 ||
    !p[0].metadata ||
    Object.keys(p[0].metadata).length !== 1 ||
    new TextDecoder('utf-8', { fatal: true }).decode(p[0].metadata.encoding) !== 'json/plain'
  )
    throw new Error('history_payload');
  new TextDecoder('utf-8', { fatal: true }).decode(p[0].data);
  const value: unknown = defaultPayloadConverter.fromPayload({ data: p[0].data, metadata: p[0].metadata });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('history_payload');
  return value as Record<string, unknown>;
}

function time(event: Event): number {
  const t = event.eventTime;
  const ms = Number(t?.seconds?.toString()) * 1000 + Number(t?.nanos ?? 0) / 1e6;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('history_time');
  return ms;
}

/** Entire contiguous history, not open/pending counts. Read-only preflight activities are separate actors. */
export function naturalPushHistory(
  events: readonly Event[],
  input: PushHandbackPreflightInput,
  currentActivityId: string | undefined,
  taskQueue: string,
): NaturalPushHistory {
  if (
    !events.length ||
    events.length > 20_000 ||
    events.some((e, i) => e.eventId?.toString() !== String(i + 1))
  )
    throw new Error('history_incomplete');
  const first = events[0]!;
  const start = first.workflowExecutionStartedEventAttributes;
  if (
    !start ||
    start.workflowType?.name !== 'taskWorkflow' ||
    start.taskQueue?.name !== taskQueue ||
    canonical(decode(start.input)) !== canonical(input.task)
  )
    throw new Error('history_start_identity');
  const scheduled = events.filter((e) => !!e.activityTaskScheduledEventAttributes);
  const actors = new Set<string>();
  const runIds: string[] = [];
  const statesBySchedule = new Map<string, Event[]>();
  for (const e of events) {
    const attributes =
      e.activityTaskStartedEventAttributes ??
      e.activityTaskCompletedEventAttributes ??
      e.activityTaskFailedEventAttributes ??
      e.activityTaskTimedOutEventAttributes ??
      e.activityTaskCanceledEventAttributes ??
      e.activityTaskCancelRequestedEventAttributes;
    const id = attributes?.scheduledEventId?.toString();
    if (id) {
      const rows = statesBySchedule.get(id) ?? [];
      rows.push(e);
      statesBySchedule.set(id, rows);
    }
  }
  let failedHead: string | undefined;
  let selfObserved = currentActivityId === undefined;
  for (const event of scheduled) {
    const s = event.activityTaskScheduledEventAttributes!;
    const name = s.activityType?.name;
    const states = statesBySchedule.get(event.eventId!.toString()) ?? [];
    if (name === 'readPushHandbackPreflight') {
      if (s.activityId === currentActivityId) {
        if (canonical(decode(s.input)) !== canonical(input)) throw new Error('history_preflight_identity');
        selfObserved = true;
      }
      continue;
    }
    if (failedHead && !['saveTaskState', 'raiseAlert'].includes(name ?? ''))
      throw new Error('history_actor_after_failed_push');
    if (failedHead && decode(s.input).taskId !== input.task.taskId)
      throw new Error('history_bookkeeping_identity');
    const starts = states.filter((e) => e.activityTaskStartedEventAttributes);
    const completed = states.filter((e) => e.activityTaskCompletedEventAttributes);
    const failed = states.filter((e) => e.activityTaskFailedEventAttributes);
    if (
      starts.length !== 1 ||
      starts[0]!.activityTaskStartedEventAttributes!.attempt !== 1 ||
      states.some(
        (e) =>
          e.activityTaskTimedOutEventAttributes ||
          e.activityTaskCanceledEventAttributes ||
          e.activityTaskCancelRequestedEventAttributes,
      )
    )
      throw new Error('history_attempt_unknown');
    const terminal = completed[0] ?? failed[0];
    const started = starts[0]!;
    const terminalAttributes =
      terminal?.activityTaskCompletedEventAttributes ?? terminal?.activityTaskFailedEventAttributes;
    if (
      !terminal ||
      Number(started.eventId!.toString()) <= Number(event.eventId!.toString()) ||
      Number(terminal.eventId!.toString()) <= Number(started.eventId!.toString()) ||
      terminalAttributes?.startedEventId?.toString() !== started.eventId!.toString() ||
      time(started) < time(event) ||
      time(terminal) < time(started)
    )
      throw new Error('history_actor_order');
    const identity = started.activityTaskStartedEventAttributes!.identity;
    if (!identity || !/^[1-9][0-9]{0,9}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(identity))
      throw new Error('history_worker');
    actors.add(identity);
    if (failed.length) {
      const f = failed[0]!.activityTaskFailedEventAttributes!;
      if (
        failed.length !== 1 ||
        completed.length ||
        name !== 'pushBranch' ||
        (f.failure?.cause?.applicationFailureInfo?.type !== 'WORKFLOWS_PERMISSION' &&
          f.failure?.applicationFailureInfo?.type !== 'WORKFLOWS_PERMISSION')
      )
        throw new Error('history_non_natural_terminal');
      const push = decode(s.input);
      if (
        failedHead ||
        push.taskId !== input.task.taskId ||
        push.worktreePath !== input.path ||
        push.branch !== input.branch ||
        push.prNumber !== undefined ||
        canonical(push.repo) !== canonical(input.task.repo) ||
        typeof push.head !== 'string' ||
        !/^[0-9a-f]{40}$/.test(push.head)
      )
        throw new Error('history_push_identity');
      failedHead = push.head;
    } else if (completed.length !== 1) throw new Error('history_actor_not_terminal');
    if (name === 'runSegment') {
      const args = decode(s.input),
        result = decode(completed[0]!.activityTaskCompletedEventAttributes!.result);
      if (
        args.taskId !== input.task.taskId ||
        args.worktreePath !== input.path ||
        args.branch !== input.branch ||
        args.attach !== undefined ||
        result.ok !== true ||
        result.attach !== undefined ||
        result.detached !== undefined ||
        typeof result.runId !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.runId)
      )
        throw new Error('history_segment_identity');
      runIds.push(result.runId);
    }
  }
  if (
    !selfObserved ||
    actors.size !== 1 ||
    !failedHead ||
    !runIds.length ||
    runIds.length > 16 ||
    new Set(runIds).size !== runIds.length
  )
    throw new Error('history_natural_shape_unknown');
  if (
    events.some(
      (e) =>
        e.workflowExecutionSignaledEventAttributes ||
        e.workflowExecutionCancelRequestedEventAttributes ||
        e.workflowExecutionTerminatedEventAttributes ||
        e.workflowExecutionContinuedAsNewEventAttributes,
    )
  )
    throw new Error('history_control_changed');
  return {
    worker: [...actors][0]!,
    runIds,
    failedHead,
    sinceMs: Math.floor(time(first)),
    sha256: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
  };
}

export async function readNaturalPushHistory(
  connection: Connection,
  namespace: string,
  input: PushHandbackPreflightInput,
  activityId: string | undefined,
  taskQueue: string,
  signal: AbortSignal,
): Promise<NaturalPushHistory> {
  const cap = connection.options.channelArgs?.['grpc.max_receive_message_length'];
  if (typeof cap !== 'number' || cap < 1 || cap > 2 * 1024 * 1024)
    throw new Error('history_connection_unbounded');
  const events: Event[] = [];
  const seen = new Set<string>();
  let token = new Uint8Array();
  let bytes = 0;
  const until = Date.now() + 45_000;
  for (let page = 0; page < 64; page++) {
    signal.throwIfAborted();
    if (Date.now() >= until) throw new Error('history_deadline');
    const response = await connection.withAbortSignal(signal, () =>
      connection.withDeadline(Math.min(until, Date.now() + 10_000), () =>
        connection.workflowService.getWorkflowExecutionHistory({
          namespace,
          execution: { workflowId: input.workflowId, runId: input.runId },
          maximumPageSize: 512,
          nextPageToken: token,
          waitNewEvent: false,
          skipArchival: true,
        }),
      ),
    );
    if (response.archived || response.rawHistory?.length || !response.history?.events?.length)
      throw new Error('history_incomplete');
    bytes += Buffer.byteLength(JSON.stringify(response));
    if (bytes > 8 * 1024 * 1024 || events.length + response.history.events.length > 20_000)
      throw new Error('history_limit');
    events.push(...response.history.events);
    const next = response.nextPageToken;
    if (!next?.length) return naturalPushHistory(events, input, activityId, taskQueue);
    const key = Buffer.from(next).toString('hex');
    if (seen.has(key)) throw new Error('history_page_repeat');
    seen.add(key);
    token = Uint8Array.from(next);
  }
  throw new Error('history_page_limit');
}
