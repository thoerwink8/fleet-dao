// 私有管理命令的可信原 execution 读取；不接受上传历史，不追 latest 或前序 run。
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Connection, isGrpcCancelledError, isGrpcDeadlineError } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import proto, { type temporal as Temporal } from '@temporalio/proto';

const { temporal } = proto;

import { temporalSettings } from './config.ts';

export const ACCEPTANCE_HISTORY_LIMITS = {
  totalMs: 30_000,
  rpcMs: 5_000,
  responseBytes: 2 * 1024 * 1024,
  payloadBytes: 256 * 1024,
  pages: 256,
  events: 20_000,
  bytes: 32 * 1024 * 1024,
  tokenBytes: 16 * 1024,
} as const;
export interface AcceptanceExecutionIdentity {
  taskId: string;
  repo: string;
  issueNumber: number;
  workflowId: string;
  temporalRunId: string;
  prNumber: number;
  head: string;
}
export interface AcceptanceItemProof {
  kind: 'acceptanceDuties' | 'coldVerify';
  prNumber: number;
  head: string;
  items: string[];
  scheduled: string;
  completed: string;
  payloadHash: string;
}
export interface AcceptanceExecutionProof {
  namespace: string;
  workflowId: string;
  runId: string;
  taskId: string;
  repo: string;
  issueNumber: number;
  workflowType: string;
  taskQueue: string;
  startHash: string;
  closeEvent: string;
  status: number;
  final: { scheduled: string; completed: string; payloadHash: string; head: string; prNumber: number };
  sources: AcceptanceItemProof[];
}
export type AcceptanceExecutionRead =
  | {
      kind: 'observed';
      proof: AcceptanceExecutionProof;
      stats: { events: number; pages: number; bytes: number };
    }
  | { kind: 'unknown'; code: string };
export interface AcceptanceExecutionReader {
  read(identity: AcceptanceExecutionIdentity, signal?: AbortSignal): Promise<AcceptanceExecutionRead>;
}
type HistoryConnection = Pick<Connection, 'withDeadline' | 'withAbortSignal' | 'options'> & {
  workflowService: Pick<
    Connection['workflowService'],
    'describeWorkflowExecution' | 'getWorkflowExecutionHistory'
  >;
};
type Payload = Temporal.api.common.v1.IPayload;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fail(code: string): never {
  throw new ReaderFailure(code);
}
class ReaderFailure extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('decode_failed');
  return value as Record<string, unknown>;
}
function payload(values: Temporal.api.common.v1.IPayloads | null | undefined) {
  if (values?.payloads?.length !== 1) return fail('malformed_payload');
  const p = values.payloads[0];
  if (!p?.data || p.data.byteLength > ACCEPTANCE_HISTORY_LIMITS.payloadBytes) return fail('limit');
  const m = p.metadata;
  if (
    !m ||
    Object.keys(m).length !== 1 ||
    !m.encoding ||
    m.encoding.byteLength > 32 ||
    new TextDecoder('utf-8', { fatal: true }).decode(m.encoding) !== 'json/plain'
  )
    return fail('unsupported_encoding');
  new TextDecoder('utf-8', { fatal: true }).decode(p.data);
  return { value: object(defaultPayloadConverter.fromPayload(p as Required<Payload>)), hash: digest(p.data) };
}
const repoName = (value: unknown) =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? `${(value as Record<string, unknown>).owner}/${(value as Record<string, unknown>).name}`
      : '';
function sameTask(v: Record<string, unknown>, id: AcceptanceExecutionIdentity) {
  return v.taskId === id.taskId && repoName(v.repo) === id.repo && v.issueNumber === id.issueNumber;
}
function items(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 2048 || v.some((x) => typeof x !== 'string' || !x.length))
    return fail('malformed_items');
  return v as string[];
}
const closeEventTypes: Record<number, number> = { 2: 2, 3: 3, 4: 21, 5: 27, 6: 28, 7: 4 };
const closeTypes: Record<number, string> = {
  2: 'workflowExecutionCompletedEventAttributes',
  3: 'workflowExecutionFailedEventAttributes',
  4: 'workflowExecutionCanceledEventAttributes',
  5: 'workflowExecutionTerminatedEventAttributes',
  6: 'workflowExecutionContinuedAsNewEventAttributes',
  7: 'workflowExecutionTimedOutEventAttributes',
};

/** 专用连接必须由公开 SDK 创建且明确限接收。测试可注入同一公开 RPC 接口。 */
export function acceptanceExecutionReader(
  connection: HistoryConnection,
  namespace: string,
  remainingMs: number = ACCEPTANCE_HISTORY_LIMITS.totalMs,
): AcceptanceExecutionReader {
  const receive = connection.options.channelArgs?.['grpc.max_receive_message_length'];
  if (typeof receive !== 'number' || receive <= 0 || receive > ACCEPTANCE_HISTORY_LIMITS.responseBytes)
    throw new Error('验收历史连接必须明确限制接收字节');
  return {
    async read(identity, parentSignal) {
      const id = structuredClone(identity),
        deadline = performance.now() + Math.max(0, Math.min(remainingMs, ACCEPTANCE_HISTORY_LIMITS.totalMs));
      const controller = new AbortController();
      const abort = () => controller.abort();
      parentSignal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
      const check = () => {
        if (parentSignal?.aborted) fail('cancelled');
        if (performance.now() >= deadline || controller.signal.aborted) fail('deadline');
      };
      const rpc = async <T>(fn: () => Promise<T>): Promise<T> => {
        check();
        const result = await connection.withAbortSignal(controller.signal, () =>
          connection.withDeadline(
            Date.now() + Math.min(deadline - performance.now(), ACCEPTANCE_HISTORY_LIMITS.rpcMs),
            fn,
          ),
        );
        check();
        return result;
      };
      try {
        if (
          ![namespace, id.taskId, id.repo, id.workflowId, id.temporalRunId, id.head].every(
            (v) => typeof v === 'string' && !!v && v.trim() === v && Buffer.byteLength(v) <= 1024,
          )
        )
          fail('invalid_context');
        const execution = { workflowId: id.workflowId, runId: id.temporalRunId };
        const desc = await rpc(() =>
          connection.workflowService.describeWorkflowExecution({ namespace, execution }),
        );
        const info = desc.workflowExecutionInfo;
        if (
          !info ||
          info.execution?.workflowId !== id.workflowId ||
          info.execution.runId !== id.temporalRunId ||
          info.type?.name !== 'taskWorkflow' ||
          !info.closeTime ||
          !closeTypes[info.status ?? 0] ||
          !desc.executionConfig?.taskQueue?.name
        )
          fail('identity_conflict');
        const taskQueue = desc.executionConfig.taskQueue.name;
        const scheduled = new Map<string, { kind: string; value: Record<string, unknown>; hash: string }>();
        const sources: AcceptanceItemProof[] = [];
        let final: AcceptanceExecutionProof['final'] | undefined;
        let token: Uint8Array = new Uint8Array(),
          last = 0n,
          events = 0,
          pages = 0,
          bytes = 0,
          startHash = '',
          closed = false;
        const seen = new Set<string>();
        for (;;) {
          const response = await rpc(() =>
            connection.workflowService.getWorkflowExecutionHistory({
              namespace,
              execution,
              maximumPageSize: 128,
              nextPageToken: token,
              waitNewEvent: false,
              skipArchival: true,
              historyEventFilterType: 1,
            }),
          );
          const size =
            temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse.encode(response).finish()
              .byteLength;
          bytes += size;
          pages++;
          const es = response.history?.events;
          if (
            size > ACCEPTANCE_HISTORY_LIMITS.responseBytes ||
            bytes > ACCEPTANCE_HISTORY_LIMITS.bytes ||
            pages > ACCEPTANCE_HISTORY_LIMITS.pages ||
            events + (es?.length ?? 0) > ACCEPTANCE_HISTORY_LIMITS.events
          )
            fail('limit');
          if (response.rawHistory?.length || response.archived || !es?.length) fail('malformed_history');
          for (const event of es) {
            check();
            const n = BigInt(event.eventId?.toString() ?? '0');
            if (closed || n !== last + 1n) fail('malformed_history');
            last = n;
            events++;
            if (n === 1n) {
              const start = event.workflowExecutionStartedEventAttributes;
              if (
                event.eventType !== 1 ||
                !start ||
                start.workflowType?.name !== 'taskWorkflow' ||
                start.taskQueue?.name !== taskQueue
              )
                fail('identity_conflict');
              const decoded = payload(start.input);
              if (!sameTask(decoded.value, id)) fail('identity_conflict');
              startHash = decoded.hash;
            }
            if (n !== 1n && event.workflowExecutionStartedEventAttributes) fail('malformed_history');
            const a = event.activityTaskScheduledEventAttributes;
            if (a?.activityType?.name === 'acceptanceDuties' || a?.activityType?.name === 'coldVerify') {
              if (event.eventType !== 10) fail('malformed_history');
              const decoded = payload(a.input);
              if (!sameTask(decoded.value, id)) fail('identity_conflict');
              scheduled.set(n.toString(), {
                kind: a.activityType.name,
                value: decoded.value,
                hash: decoded.hash,
              });
            }
            const c = event.activityTaskCompletedEventAttributes;
            if (c) {
              const sid = c.scheduledEventId?.toString() ?? '',
                record = scheduled.get(sid);
              if (record) {
                if (event.eventType !== 12) fail('malformed_history');
                const result = payload(c.result);
                if (record.kind === 'acceptanceDuties') {
                  if (!Array.isArray(record.value.record) || record.value.record.length > 64)
                    fail('malformed_items');
                  for (const raw of record.value.record) {
                    const r = object(raw);
                    if (
                      typeof r.prNumber !== 'number' ||
                      !Number.isSafeInteger(r.prNumber) ||
                      typeof r.head !== 'string'
                    )
                      fail('identity_conflict');
                    sources.push({
                      kind: 'acceptanceDuties',
                      prNumber: r.prNumber,
                      head: r.head,
                      items: items(r.items),
                      scheduled: sid,
                      completed: n.toString(),
                      payloadHash: record.hash,
                    });
                  }
                } else {
                  const v = record.value;
                  if (typeof v.prNumber !== 'number' || typeof v.headSha !== 'string')
                    fail('identity_conflict');
                  if (result.value.outOfScope !== undefined)
                    sources.push({
                      kind: 'coldVerify',
                      prNumber: v.prNumber,
                      head: v.headSha,
                      items: items(result.value.outOfScope),
                      scheduled: sid,
                      completed: n.toString(),
                      payloadHash: result.hash,
                    });
                  if (v.prNumber === id.prNumber && v.headSha === id.head)
                    final =
                      result.value.pass === true
                        ? {
                            scheduled: sid,
                            completed: n.toString(),
                            payloadHash: result.hash,
                            head: id.head,
                            prNumber: id.prNumber,
                          }
                        : undefined;
                }
              }
            }
            const kind = closeTypes[info.status ?? 0];
            if (kind && (event as Record<string, unknown>)[kind]) {
              if (event.eventType !== closeEventTypes[info.status ?? 0]) fail('identity_conflict');
              closed = true;
            } else if (Object.values(closeTypes).some((k) => !!(event as Record<string, unknown>)[k]))
              fail('identity_conflict');
          }
          token = response.nextPageToken ?? new Uint8Array();
          if (!token.byteLength) break;
          if (closed) fail('malformed_history');
          if (token.byteLength > ACCEPTANCE_HISTORY_LIMITS.tokenBytes) fail('limit');
          const key = Buffer.from(token).toString('base64');
          if (seen.has(key)) fail('malformed_history');
          seen.add(key);
        }
        if (!closed || !startHash || !final || info.historyLength?.toString() !== last.toString())
          fail('incomplete_proof');
        const after = await rpc(() =>
          connection.workflowService.describeWorkflowExecution({ namespace, execution }),
        );
        const stable = (v: typeof desc) =>
          JSON.stringify({
            execution: v.workflowExecutionInfo?.execution,
            status: v.workflowExecutionInfo?.status,
            close: v.workflowExecutionInfo?.closeTime,
            length: v.workflowExecutionInfo?.historyLength?.toString(),
            type: v.workflowExecutionInfo?.type,
            queue: v.executionConfig?.taskQueue,
          });
        if (stable(desc) !== stable(after)) fail('identity_conflict');
        check();
        return {
          kind: 'observed',
          proof: {
            namespace,
            workflowId: id.workflowId,
            runId: id.temporalRunId,
            taskId: id.taskId,
            repo: id.repo,
            issueNumber: id.issueNumber,
            workflowType: 'taskWorkflow',
            taskQueue,
            startHash,
            closeEvent: last.toString(),
            status: info.status!,
            final,
            sources,
          },
          stats: { events, pages, bytes },
        };
      } catch (error) {
        return {
          kind: 'unknown',
          code: parentSignal?.aborted
            ? 'cancelled'
            : performance.now() >= deadline || controller.signal.aborted || isGrpcDeadlineError(error)
              ? 'deadline'
              : isGrpcCancelledError(error)
                ? 'cancelled'
                : error instanceof ReaderFailure
                  ? error.message
                  : 'read_failed',
        };
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abort);
      }
    },
  };
}

/** 建连也计入同一30秒预算；无关命令不会创建此连接。 */
export function openAcceptanceExecutionReader(
  env: Record<string, string | undefined>,
): AcceptanceExecutionReader {
  const config = temporalSettings(env);
  return {
    async read(identity, signal) {
      if (signal?.aborted) return { kind: 'unknown', code: 'cancelled' };
      const started = performance.now();
      let connection: Connection | undefined;
      try {
        // 保留公开连接句柄：SDK的connect失败时不会替调用方关闭它。
        // ensureConnected没有公开AbortSignal；取消最迟在5秒建连期限后观察。
        connection = Connection.lazy({
          address: config.temporalAddress,
          connectTimeout: ACCEPTANCE_HISTORY_LIMITS.rpcMs,
          interceptors: [],
          channelArgs: { 'grpc.max_receive_message_length': ACCEPTANCE_HISTORY_LIMITS.responseBytes },
        });
        await connection.ensureConnected();
        if (signal?.aborted) return { kind: 'unknown', code: 'cancelled' };
        const remaining = ACCEPTANCE_HISTORY_LIMITS.totalMs - (performance.now() - started);
        if (remaining <= 0) return { kind: 'unknown', code: 'deadline' };
        return await acceptanceExecutionReader(connection, config.temporalNamespace, remaining).read(
          identity,
          signal,
        );
      } catch {
        return {
          kind: 'unknown',
          code: signal?.aborted
            ? 'cancelled'
            : performance.now() - started >= ACCEPTANCE_HISTORY_LIMITS.totalMs
              ? 'deadline'
              : 'connection_failed',
        };
      } finally {
        await connection?.close();
      }
    },
  };
}
