import { defaultPayloadConverter } from '@temporalio/common';
import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTION_HISTORY_MAX_BYTES,
  EXECUTION_START_INPUT_MAX_BYTES,
  EXECUTION_START_READ_MS,
  type ExecutionHistoryConnection,
  executionStartReader,
  type ObservedExecution,
} from '../src/real/execution-start-reader.ts';

type History = Partial<
  Awaited<ReturnType<ExecutionHistoryConnection['workflowService']['getWorkflowExecutionHistory']>>
>;
type EventId = NonNullable<NonNullable<NonNullable<History['history']>['events']>[number]['eventId']>;
// Unit 只替身事件号的公开 toString；真实 protobuf/Long 在 real 测试验证。
const eventId = (n: number) => ({ toString: () => String(n) }) as EventId;
const identity = (): ObservedExecution => ({
  namespace: 'default',
  workflowId: 'task-1',
  runId: 'run-1',
  workflowType: 'taskWorkflow',
  taskQueue: 'engine',
  isLocal: true,
});
function history(input: unknown = { taskId: 'task-1', opId: 'operation-1' }): History {
  return {
    history: {
      events: [
        {
          eventId: eventId(1),
          eventType: 1,
          workflowExecutionStartedEventAttributes: {
            workflowType: { name: 'taskWorkflow' },
            taskQueue: { name: 'engine' },
            input: { payloads: [defaultPayloadConverter.toPayload(input)] },
          },
        },
      ],
    },
  };
}
function setup(response: History = history()) {
  const rpc = vi.fn(async () => response);
  const deadlines: number[] = [];
  const signals: AbortSignal[] = [];
  const connection = {
    options: { channelArgs: { 'grpc.max_receive_message_length': EXECUTION_HISTORY_MAX_BYTES } },
    workflowService: { getWorkflowExecutionHistory: rpc },
    withDeadline: async <T>(deadline: number | Date, fn: () => Promise<T>): Promise<T> => {
      deadlines.push(Number(deadline));
      return fn();
    },
    withAbortSignal: async <T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> => {
      signals.push(signal);
      return fn();
    },
  } as unknown as ExecutionHistoryConnection;
  const controller = new AbortController();
  return {
    connection,
    rpc,
    deadlines,
    signals,
    controller,
    read: (observed = identity()) => executionStartReader(connection).read(observed, controller.signal),
  };
}
function started(response: History) {
  const value = response.history?.events?.[0]?.workflowExecutionStartedEventAttributes;
  if (!value) throw new Error('fixture 缺少 Start');
  return value;
}
function payload(response: History) {
  const value = started(response).input?.payloads?.[0];
  if (!value) throw new Error('fixture 缺少 payload');
  return value;
}

describe('精确运行 Start 只读证据', () => {
  it('绑定精确 run、首事件、默认 converter、期限和取消信号，不翻页或读取 latest', async () => {
    const s = setup();
    const before = Date.now();
    await expect(s.read()).resolves.toEqual({
      kind: 'observed',
      observed: identity(),
      startEventId: '1',
      input: { taskId: 'task-1', opId: 'operation-1' },
    });
    expect(s.rpc).toHaveBeenCalledExactlyOnceWith({
      namespace: 'default',
      execution: { workflowId: 'task-1', runId: 'run-1' },
      maximumPageSize: 1,
      nextPageToken: new Uint8Array(),
      waitNewEvent: false,
      skipArchival: true,
    });
    expect(s.signals).toEqual([s.controller.signal]);
    expect(s.deadlines[0]).toBeGreaterThanOrEqual(before + EXECUTION_START_READ_MS);
    expect(s.deadlines[0]).toBeLessThanOrEqual(Date.now() + EXECUTION_START_READ_MS);
  });

  it.each([undefined, 0, -1, Infinity, 1.5, EXECUTION_HISTORY_MAX_BYTES + 1, '2097152'])(
    '连接接收上限缺失或非法时，拒绝建立 reader（%s）',
    (limit) => {
      const s = setup();
      (s.connection.options.channelArgs as Record<string, unknown>)['grpc.max_receive_message_length'] =
        limit;
      expect(() => executionStartReader(s.connection)).toThrow(/接收上限/);
      expect(s.rpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    { runId: '' },
    { namespace: ' default' },
    { workflowId: 'x'.repeat(1025) },
    { isLocal: false },
    { taskQueue: '' },
    { workflowType: '' },
  ])('非法活动上下文在 IO 前拒绝：%j', async (patch) => {
    const s = setup();
    await expect(s.read({ ...identity(), ...patch } as ObservedExecution)).resolves.toEqual({
      kind: 'unknown',
      code: 'invalid_context',
    });
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it('调用途中篡改原 identity，不改变请求或返回证据身份', async () => {
    const s = setup();
    const observed = identity();
    s.rpc.mockImplementation(async () => {
      observed.runId = 'other';
      observed.taskQueue = 'other';
      return history();
    });
    await expect(s.read(observed)).resolves.toMatchObject({ kind: 'observed', observed: identity() });
  });

  it('预先取消不 IO，RPC 返回后取消也不给成功证据', async () => {
    const first = setup();
    first.controller.abort();
    await expect(first.read()).resolves.toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(first.rpc).not.toHaveBeenCalled();
    const second = setup();
    second.rpc.mockImplementation(async () => {
      second.controller.abort();
      return history();
    });
    await expect(second.read()).resolves.toEqual({ kind: 'unknown', code: 'cancelled' });
  });

  it.each([
    {},
    { history: { events: [] } },
    { rawHistory: [{ data: new Uint8Array([1]) }] },
    { archived: true },
    { history: { events: [{ eventId: eventId(2), eventType: 1 }] } },
  ] satisfies History[])('无首事件或归档/原始历史不会猜成成功：%j', async (response) => {
    await expect(setup(response).read()).resolves.toEqual({ kind: 'unknown', code: 'malformed_history' });
  });

  it.each(['workflowType', 'taskQueue'] as const)('Start 的 %s 与本地活动身份不一致时拒绝', async (field) => {
    const response = history();
    started(response)[field] = { name: 'other' };
    await expect(setup(response).read()).resolves.toEqual({ kind: 'unknown', code: 'identity_conflict' });
  });

  it.each([
    { payloads: [] },
    { payloads: [defaultPayloadConverter.toPayload({}), defaultPayloadConverter.toPayload({})] },
  ])('缺少或多参数不能默默选择第一个', async ({ payloads }) => {
    const response = history();
    started(response).input = { payloads };
    await expect(setup(response).read()).resolves.toEqual({ kind: 'unknown', code: 'malformed_history' });
  });

  it('过大输入拒绝而非解码', async () => {
    const response = history();
    payload(response).data = new Uint8Array(EXECUTION_START_INPUT_MAX_BYTES + 1);
    await expect(setup(response).read()).resolves.toEqual({ kind: 'unknown', code: 'limit' });
  });

  it.each([
    {},
    { encoding: Buffer.from('binary/plain') },
    { encoding: Buffer.from('json/plain'), codec: Buffer.from('custom') },
  ])('不认识的 codec/metadata 不套默认 JSON：%j', async (metadata) => {
    const response = history();
    payload(response).metadata = metadata;
    await expect(setup(response).read()).resolves.toEqual({ kind: 'unknown', code: 'unsupported_encoding' });
  });

  it.each([null, [], true, 3, 'private text'])('只接受对象型输入：%j', async (input) => {
    await expect(setup(history(input)).read()).resolves.toEqual({ kind: 'unknown', code: 'decode_failed' });
  });

  it.each([Buffer.from('{broken'), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])])(
    '损坏 JSON 或 UTF8 返回未知，不用替换字符冒充原文',
    async (data) => {
      const response = history();
      payload(response).data = data;
      await expect(setup(response).read()).resolves.toEqual({ kind: 'unknown', code: 'decode_failed' });
    },
  );

  it.each([
    [1, 'cancelled'],
    [4, 'deadline'],
    [5, 'not_found'],
    [8, 'limit'],
    [14, 'unavailable'],
  ] as const)('gRPC %s 分类为 %s，并且不泄露服务端原文', async (code, expected) => {
    const s = setup();
    s.rpc.mockRejectedValue(
      Object.assign(new Error('private start input'), { code, details: 'private', metadata: {} }),
    );
    await expect(s.read()).resolves.toEqual({ kind: 'unknown', code: expected });
  });

  it('普通 RPC 错误明确为 unavailable，不能与解码失败混淆', async () => {
    const s = setup();
    s.rpc.mockRejectedValue(new Error('private details'));
    await expect(s.read()).resolves.toEqual({ kind: 'unknown', code: 'unavailable' });
  });
});
