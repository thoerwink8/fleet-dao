// 执行资格的只读前置：精确读取一个 run 的原始 Start 参数，不找 latest，不修改任务或资格。
// 仅支持现行默认 JSON PayloadConverter；接线前仍须可信核对 ActivityInfo、任务和派发身份。
import {
  type Connection,
  isGrpcCancelledError,
  isGrpcDeadlineError,
  isGrpcServiceError,
} from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';

export const EXECUTION_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
export const EXECUTION_START_INPUT_MAX_BYTES = 256 * 1024;
export const EXECUTION_START_READ_MS = 5_000;

export interface ObservedExecution {
  namespace: string;
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue: string;
  isLocal: true;
}

type ReadFailure =
  | 'invalid_context'
  | 'cancelled'
  | 'deadline'
  | 'not_found'
  | 'unavailable'
  | 'limit'
  | 'malformed_history'
  | 'identity_conflict'
  | 'unsupported_encoding'
  | 'decode_failed';

export type ExecutionStartRead =
  | { kind: 'observed'; observed: ObservedExecution; startEventId: '1'; input: Record<string, unknown> }
  | { kind: 'unknown'; code: ReadFailure };

export type ExecutionHistoryConnection = Pick<Connection, 'options' | 'withDeadline' | 'withAbortSignal'> & {
  workflowService: Pick<Connection['workflowService'], 'getWorkflowExecutionHistory'>;
};

function validContext(value: ObservedExecution): boolean {
  return (
    value.isLocal === true &&
    [value.namespace, value.workflowId, value.runId, value.workflowType, value.taskQueue].every(
      (v) => typeof v === 'string' && v.length > 0 && v.trim() === v && Buffer.byteLength(v) <= 1024,
    )
  );
}

/**
 * 传入公开 Connection.connect 创建、显式限接收大小的专用只读连接。
 * 用 interceptors: [] 保留原始 RPC 错误；SDK 默认重试可将大小超限变为 deadline，仍返回未知。
 */
export function executionStartReader(connection: ExecutionHistoryConnection): {
  read(observed: ObservedExecution, signal: AbortSignal): Promise<ExecutionStartRead>;
} {
  const receiveLimit = connection.options.channelArgs?.['grpc.max_receive_message_length'];
  if (
    typeof receiveLimit !== 'number' ||
    !Number.isSafeInteger(receiveLimit) ||
    receiveLimit <= 0 ||
    receiveLimit > EXECUTION_HISTORY_MAX_BYTES
  ) {
    throw new Error('执行历史读取连接须显式设置不超过 2MiB 的 gRPC 接收上限');
  }
  return {
    async read(observed, signal) {
      if (!validContext(observed)) return { kind: 'unknown', code: 'invalid_context' };
      if (signal.aborted) return { kind: 'unknown', code: 'cancelled' };
      // 在第一个 await 前固定调用方值；不能在 RPC 期间换 run 或队列后给另一身份背书。
      const identity = { ...observed };
      let response: Awaited<ReturnType<Connection['workflowService']['getWorkflowExecutionHistory']>>;
      try {
        response = await connection.withAbortSignal(signal, () =>
          connection.withDeadline(Date.now() + EXECUTION_START_READ_MS, () =>
            connection.workflowService.getWorkflowExecutionHistory({
              namespace: identity.namespace,
              execution: { workflowId: identity.workflowId, runId: identity.runId },
              maximumPageSize: 1,
              nextPageToken: new Uint8Array(),
              waitNewEvent: false,
              skipArchival: true,
            }),
          ),
        );
      } catch (error) {
        if (signal.aborted || isGrpcCancelledError(error)) return { kind: 'unknown', code: 'cancelled' };
        if (isGrpcDeadlineError(error)) return { kind: 'unknown', code: 'deadline' };
        if (isGrpcServiceError(error)) {
          if (error.code === 5) return { kind: 'unknown', code: 'not_found' };
          if (error.code === 8) return { kind: 'unknown', code: 'limit' };
        }
        // RPC 失败与参数解码失败分开；错误原文可能包含私有输入，不返回给调用方。
        return { kind: 'unknown', code: 'unavailable' };
      }
      try {
        if (signal.aborted) return { kind: 'unknown', code: 'cancelled' };
        // 不解析 rawHistory 或取下一页补猜。首事件必须来自本次精确 run 的普通历史。
        if (response.rawHistory?.length || response.archived)
          return { kind: 'unknown', code: 'malformed_history' };
        const events = response.history?.events;
        if (!events?.length || events.length > 32) return { kind: 'unknown', code: 'malformed_history' };
        const first = events[0];
        const started = first?.workflowExecutionStartedEventAttributes;
        if (first?.eventId?.toString() !== '1' || first.eventType !== 1 || !started)
          return { kind: 'unknown', code: 'malformed_history' };
        if (
          started.workflowType?.name !== identity.workflowType ||
          started.taskQueue?.name !== identity.taskQueue
        )
          return { kind: 'unknown', code: 'identity_conflict' };
        const payloads = started.input?.payloads;
        if (payloads?.length !== 1) return { kind: 'unknown', code: 'malformed_history' };
        const payload = payloads[0];
        if (!payload?.data || payload.data.byteLength > EXECUTION_START_INPUT_MAX_BYTES)
          return { kind: 'unknown', code: 'limit' };
        const metadata = payload.metadata;
        // 其它 metadata/编码可能依赖自定义 codec/type conversion，不能静默套默认解码。
        if (
          !metadata ||
          Object.keys(metadata).length !== 1 ||
          !metadata.encoding ||
          metadata.encoding.byteLength > 32 ||
          new TextDecoder('utf-8', { fatal: true }).decode(metadata.encoding) !== 'json/plain'
        ) {
          return { kind: 'unknown', code: 'unsupported_encoding' };
        }
        // 默认 converter 的 TextDecoder 允许替换坏 UTF-8；原始身份文本必须无损。
        new TextDecoder('utf-8', { fatal: true }).decode(payload.data);
        const input: unknown = defaultPayloadConverter.fromPayload(payload);
        if (input === null || typeof input !== 'object' || Array.isArray(input))
          return { kind: 'unknown', code: 'decode_failed' };
        return {
          kind: 'observed',
          observed: identity,
          startEventId: '1',
          input: input as Record<string, unknown>,
        };
      } catch {
        // 不返回错误原文：Start 参数、元数据和服务端错误可能包含私有输入。
        return { kind: 'unknown', code: 'decode_failed' };
      }
    },
  };
}
