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
export type HistoryConnection = Pick<Connection, 'withDeadline' | 'withAbortSignal' | 'options'> & {
  workflowService: Pick<
    Connection['workflowService'],
    'describeWorkflowExecution' | 'getWorkflowExecutionHistory'
  >;
};
type Payload = Temporal.api.common.v1.IPayload;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function executionFailure(code: string): never {
  throw new ReaderFailure(code);
}
class ReaderFailure extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return executionFailure('decode_failed');
  return value as Record<string, unknown>;
}
export function executionPayload(values: Temporal.api.common.v1.IPayloads | null | undefined) {
  if (values?.payloads?.length !== 1) return executionFailure('malformed_payload');
  const p = values.payloads[0];
  if (!p?.data || p.data.byteLength > ACCEPTANCE_HISTORY_LIMITS.payloadBytes)
    return executionFailure('limit');
  const m = p.metadata;
  if (
    !m ||
    Object.keys(m).length !== 1 ||
    !m.encoding ||
    m.encoding.byteLength > 32 ||
    new TextDecoder('utf-8', { fatal: true }).decode(m.encoding) !== 'json/plain'
  )
    return executionFailure('unsupported_encoding');
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
    return executionFailure('malformed_items');
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

export interface ExecutionContext {
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
}
export interface ExecutionInterpreter<T> {
  event(event: Temporal.api.history.v1.IHistoryEvent, check: () => void): void;
  finish(context: ExecutionContext): T;
}
export type ExecutionRead<T> =
  | { kind: 'observed'; proof: T; stats: { events: number; pages: number; bytes: number } }
  | { kind: 'unknown'; code: string };
export interface ExecutionReader<T, I extends AcceptanceExecutionIdentity = AcceptanceExecutionIdentity> {
  read(identity: I, signal?: AbortSignal): Promise<ExecutionRead<T>>;
}
function acceptanceInterpreter(
  id: AcceptanceExecutionIdentity,
): ExecutionInterpreter<AcceptanceExecutionProof> {
  const scheduled = new Map<string, { kind: string; value: Record<string, unknown>; hash: string }>();
  const sources: AcceptanceItemProof[] = [];
  let final: AcceptanceExecutionProof['final'] | undefined;
  return {
    event(event) {
      const n = BigInt(event.eventId?.toString() ?? '0');
      const a = event.activityTaskScheduledEventAttributes;
      if (a?.activityType?.name === 'acceptanceDuties' || a?.activityType?.name === 'coldVerify') {
        if (event.eventType !== 10) executionFailure('malformed_history');
        const decoded = executionPayload(a.input);
        if (!sameTask(decoded.value, id)) executionFailure('identity_conflict');
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
          if (event.eventType !== 12) executionFailure('malformed_history');
          const result = executionPayload(c.result);
          if (record.kind === 'acceptanceDuties') {
            if (!Array.isArray(record.value.record) || record.value.record.length > 64)
              executionFailure('malformed_items');
            for (const raw of record.value.record) {
              const r = object(raw);
              if (
                typeof r.prNumber !== 'number' ||
                !Number.isSafeInteger(r.prNumber) ||
                typeof r.head !== 'string'
              )
                executionFailure('identity_conflict');
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
              executionFailure('identity_conflict');
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
    },
    finish(context) {
      if (!final) executionFailure('incomplete_proof');
      return { ...context, final, sources };
    },
  };
}
export function acceptanceExecutionReader(
  connection: HistoryConnection,
  namespace: string,
  remainingMs: number = ACCEPTANCE_HISTORY_LIMITS.totalMs,
): AcceptanceExecutionReader {
  return boundedExecutionReader(connection, namespace, acceptanceInterpreter, remainingMs);
}

/** 专用连接必须由公开 SDK 创建且明确限接收。测试可注入同一公开 RPC 接口。 */
export function boundedExecutionReader<T, I extends AcceptanceExecutionIdentity>(
  connection: HistoryConnection,
  namespace: string,
  createInterpreter: (identity: I) => ExecutionInterpreter<T>,
  remainingMs: number = ACCEPTANCE_HISTORY_LIMITS.totalMs,
): ExecutionReader<T, I> {
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
        if (parentSignal?.aborted) executionFailure('cancelled');
        if (performance.now() >= deadline || controller.signal.aborted) executionFailure('deadline');
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
          executionFailure('invalid_context');
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
          executionFailure('identity_conflict');
        const taskQueue = desc.executionConfig.taskQueue.name;
        const interpreter = createInterpreter(id);
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
            executionFailure('limit');
          if (response.rawHistory?.length || response.archived) executionFailure('malformed_history');
          // 分页只按 token 耗尽收尾（官方 SDK 同）：空页可在终态前后出现，不能单独证明缺事件；
          // 缺事件由连续 eventId、historyLength、唯一终态和 token 耗尽后的完整来源判据兜住，
          // 空页个数只受总页数、token 循环、字节和时间预算约束。
          for (const event of es ?? []) {
            check();
            const n = BigInt(event.eventId?.toString() ?? '0');
            if (closed || n !== last + 1n) executionFailure('malformed_history');
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
                executionFailure('identity_conflict');
              const decoded = executionPayload(start.input);
              if (!sameTask(decoded.value, id)) executionFailure('identity_conflict');
              startHash = decoded.hash;
            }
            if (n !== 1n && event.workflowExecutionStartedEventAttributes)
              executionFailure('malformed_history');
            interpreter.event(event, check);
            const kind = closeTypes[info.status ?? 0];
            if (kind && (event as Record<string, unknown>)[kind]) {
              if (event.eventType !== closeEventTypes[info.status ?? 0])
                executionFailure('identity_conflict');
              closed = true;
            } else if (Object.values(closeTypes).some((k) => !!(event as Record<string, unknown>)[k]))
              executionFailure('identity_conflict');
          }
          token = response.nextPageToken ?? new Uint8Array();
          if (!token.byteLength) break;
          if (token.byteLength > ACCEPTANCE_HISTORY_LIMITS.tokenBytes) executionFailure('limit');
          const key = Buffer.from(token).toString('base64');
          if (seen.has(key)) executionFailure('malformed_history');
          seen.add(key);
        }
        if (!closed || !startHash || info.historyLength?.toString() !== last.toString())
          executionFailure('incomplete_proof');
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
        if (stable(desc) !== stable(after)) executionFailure('identity_conflict');
        check();
        return {
          kind: 'observed',
          proof: interpreter.finish({
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
          }),
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
  return openExecutionReader(env, acceptanceExecutionReader);
}
export function openExecutionReader<T, I extends AcceptanceExecutionIdentity>(
  env: Record<string, string | undefined>,
  factory: (connection: HistoryConnection, namespace: string, remainingMs: number) => ExecutionReader<T, I>,
): ExecutionReader<T, I> {
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
        return await factory(connection, config.temporalNamespace, remaining).read(identity, signal);
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
