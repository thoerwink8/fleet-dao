import { performance } from 'node:perf_hooks';
import { Connection } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCEPTANCE_HISTORY_LIMITS,
  type AcceptanceExecutionIdentity,
  acceptanceExecutionReader,
  openAcceptanceExecutionReader,
} from '../src/acceptance-execution-reader.ts';

const id: AcceptanceExecutionIdentity = {
  taskId: '00000000-0000-4000-8000-000000000001',
  repo: 'o/r',
  issueNumber: 1,
  workflowId: 'task:o/r#1',
  temporalRunId: '00000000-0000-4000-8000-000000000002',
  prNumber: 2,
  head: 'f'.repeat(40),
};
const p = (v: unknown) => ({
  payloads: [{ metadata: { encoding: Buffer.from('json/plain') }, data: Buffer.from(JSON.stringify(v)) }],
});
function fixture() {
  const identity = { taskId: id.taskId, repo: { owner: 'o', name: 'r' }, issueNumber: 1 };
  const events = [
    {
      eventType: 1,
      workflowExecutionStartedEventAttributes: {
        workflowType: { name: 'taskWorkflow' },
        taskQueue: { name: 'q' },
        input: p(identity),
      },
    },
    {
      eventType: 10,
      activityTaskScheduledEventAttributes: {
        activityType: { name: 'acceptanceDuties' },
        input: p({ ...identity, record: [{ prNumber: 2, head: 'a'.repeat(40), items: ['A'] }] }),
      },
    },
    {
      eventType: 12,
      activityTaskCompletedEventAttributes: { scheduledEventId: '2', result: p({ open: [] }) },
    },
    {
      eventType: 10,
      activityTaskScheduledEventAttributes: {
        activityType: { name: 'coldVerify' },
        input: p({ ...identity, prNumber: 2, headSha: 'b'.repeat(40) }),
      },
    },
    {
      eventType: 12,
      activityTaskCompletedEventAttributes: {
        scheduledEventId: '4',
        result: p({ pass: false, outOfScope: ['B'] }),
      },
    },
    {
      eventType: 10,
      activityTaskScheduledEventAttributes: {
        activityType: { name: 'coldVerify' },
        input: p({ ...identity, prNumber: 2, headSha: id.head }),
      },
    },
    {
      eventType: 12,
      activityTaskCompletedEventAttributes: { scheduledEventId: '6', result: p({ pass: true }) },
    },
    { eventType: 2, workflowExecutionCompletedEventAttributes: {} },
  ].map((e, i) => temporal.api.history.v1.HistoryEvent.fromObject({ ...e, eventId: String(i + 1) }));
  const describe = temporal.api.workflowservice.v1.DescribeWorkflowExecutionResponse.fromObject({
    workflowExecutionInfo: {
      execution: { workflowId: id.workflowId, runId: id.temporalRunId },
      status: 2,
      historyLength: '8',
      closeTime: { seconds: 12 },
      type: { name: 'taskWorkflow' },
    },
    executionConfig: { taskQueue: { name: 'q' } },
  });
  const pages = [
    temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse.create({
      history: { events: events.slice(0, 4) },
      nextPageToken: Buffer.from('next'),
    }),
    temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse.create({
      history: { events: events.slice(4) },
    }),
  ];
  let page = 0;
  const history = vi.fn(async () => pages[page++]!);
  const connection = {
    options: { channelArgs: { 'grpc.max_receive_message_length': ACCEPTANCE_HISTORY_LIMITS.responseBytes } },
    withDeadline: async (_: number, f: () => Promise<unknown>) => f(),
    withAbortSignal: async (_: AbortSignal, f: () => Promise<unknown>) => f(),
    workflowService: {
      describeWorkflowExecution: vi.fn(async () => describe),
      getWorkflowExecutionHistory: history,
    },
  };
  return {
    events,
    describe,
    pages,
    history,
    connection,
    reader: acceptanceExecutionReader(connection as unknown as Connection, 'n'),
  };
}
describe('私有验收原 execution reader', () => {
  it('跨页关联A/B，旧失败验收只证明原项；最终关联须pass=true', async () => {
    const f = fixture(),
      result = await f.reader.read(id);
    expect(result.kind).toBe('observed');
    if (result.kind !== 'observed') throw Error('missing proof');
    expect(result.proof.sources).toMatchObject([
      { kind: 'acceptanceDuties', items: ['A'], scheduled: '2', completed: '3' },
      { kind: 'coldVerify', items: ['B'], scheduled: '4', completed: '5' },
    ]);
    expect(result.proof.final).toMatchObject({ head: id.head, scheduled: '6', completed: '7' });
    expect(result.stats).toMatchObject({ events: 8, pages: 2 });
    expect(f.history.mock.calls).toHaveLength(2);
  });
  it.each([
    { head: id.head, firstPass: true, pass: false, expected: 'unknown' },
    { head: id.head, firstPass: false, pass: true, expected: 'observed' },
    { head: 'c'.repeat(40), firstPass: true, pass: false, expected: 'observed' },
  ])(
    '最终头的最后一次完成结果决定是否有最终证明：$firstPass→$pass/$head',
    async ({ head, firstPass, pass, expected }) => {
      const f = fixture();
      f.events[6]!.activityTaskCompletedEventAttributes!.result = p({ pass: firstPass });
      f.events.pop();
      f.events.push(
        temporal.api.history.v1.HistoryEvent.fromObject({
          eventId: '8',
          eventType: 10,
          activityTaskScheduledEventAttributes: {
            activityType: { name: 'coldVerify' },
            input: p({
              taskId: id.taskId,
              repo: id.repo,
              issueNumber: id.issueNumber,
              prNumber: id.prNumber,
              headSha: head,
            }),
          },
        }),
        temporal.api.history.v1.HistoryEvent.fromObject({
          eventId: '9',
          eventType: 12,
          activityTaskCompletedEventAttributes: { scheduledEventId: '8', result: p({ pass }) },
        }),
        temporal.api.history.v1.HistoryEvent.fromObject({
          eventId: '10',
          eventType: 2,
          workflowExecutionCompletedEventAttributes: {},
        }),
      );
      f.pages[1]!.history!.events = f.events.slice(4);
      f.describe.workflowExecutionInfo!.historyLength = f.events[9]!.eventId;
      const result = await f.reader.read(id);
      expect(result.kind).toBe(expected);
      if (result.kind === 'observed') expect(result.proof.final.completed).toBe(head === id.head ? '9' : '7');
    },
  );
  it('建连期间墙钟回拨不扩大整链30秒预算', async () => {
    const f = fixture(),
      close = vi.fn(async () => {});
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const connected = Object.assign(f.connection, {
      close,
      ensureConnected: vi.fn(async () => {
        elapsed = 4_000;
        wall.mockReturnValue(1_000);
      }),
    });
    const lazy = vi.spyOn(Connection, 'lazy').mockReturnValue(connected as unknown as Connection);
    let page = 0;
    f.history.mockImplementation(async () => {
      elapsed = 30_001;
      return f.pages[page++]!;
    });
    try {
      expect(await openAcceptanceExecutionReader({}).read(id)).toEqual({ kind: 'unknown', code: 'deadline' });
      expect(f.history).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      lazy.mockRestore();
      wall.mockRestore();
      clock.mockRestore();
    }
  });
  it('公开SDK建连完成后观察取消，零历史RPC并关闭持有连接', async () => {
    const f = fixture(),
      close = vi.fn(async () => {}),
      controller = new AbortController();
    const connected = Object.assign(f.connection, {
      close,
      ensureConnected: vi.fn(async () => {
        controller.abort();
      }),
    });
    const lazy = vi.spyOn(Connection, 'lazy').mockReturnValue(connected as unknown as Connection);
    try {
      expect(await openAcceptanceExecutionReader({}).read(id, controller.signal)).toEqual({
        kind: 'unknown',
        code: 'cancelled',
      });
      expect(f.connection.workflowService.describeWorkflowExecution).not.toHaveBeenCalled();
      expect(f.history).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(lazy.mock.calls[0]?.[0]?.connectTimeout).toBe(5_000);
    } finally {
      lazy.mockRestore();
    }
  });
  it('公开SDK建连失败也关闭句柄，不遗留连接或读取历史', async () => {
    const f = fixture(),
      close = vi.fn(async () => {});
    const connected = Object.assign(f.connection, {
      close,
      ensureConnected: vi.fn(async () => {
        throw Error('private connection detail');
      }),
    });
    const lazy = vi.spyOn(Connection, 'lazy').mockReturnValue(connected as unknown as Connection);
    try {
      expect(await openAcceptanceExecutionReader({}).read(id)).toEqual({
        kind: 'unknown',
        code: 'connection_failed',
      });
      expect(f.history).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      lazy.mockRestore();
    }
  });
  it.each([
    'wrongRun',
    'wrongTask',
    'wrongQueue',
    'running',
    'gap',
    'reorder',
    'truncated',
    'loop',
    'archived',
    'raw',
    'badUtf8',
    'codec',
    'finalFalse',
    'scheduledOnly',
    'payloadLimit',
    'changedDescribe',
  ])('拒绝 %s', async (mode) => {
    const f = fixture();
    if (mode === 'wrongRun') f.describe.workflowExecutionInfo!.execution!.runId = 'other';
    if (mode === 'wrongTask')
      f.events[0]!.workflowExecutionStartedEventAttributes!.input = p({ taskId: 'other' });
    if (mode === 'wrongQueue') f.describe.executionConfig!.taskQueue!.name = 'other';
    if (mode === 'running') f.describe.workflowExecutionInfo!.status = 1;
    if (mode === 'gap')
      f.events[4]!.eventId = temporal.api.history.v1.HistoryEvent.fromObject({ eventId: '999' }).eventId;
    if (mode === 'reorder') f.pages[1]!.history!.events!.reverse();
    if (mode === 'truncated') f.pages[1]!.history!.events!.pop();
    if (mode === 'loop') f.pages[1]!.nextPageToken = Buffer.from('next');
    if (mode === 'archived') f.pages[0]!.archived = true;
    if (mode === 'raw') f.pages[0]!.rawHistory = [{ data: Buffer.from('raw') }];
    if (mode === 'badUtf8')
      f.events[0]!.workflowExecutionStartedEventAttributes!.input!.payloads![0]!.data = Buffer.from([0xff]);
    if (mode === 'codec')
      f.events[0]!.workflowExecutionStartedEventAttributes!.input!.payloads![0]!.metadata = {
        encoding: Buffer.from('binary/custom'),
      };
    if (mode === 'finalFalse') f.events[6]!.activityTaskCompletedEventAttributes!.result = p({ pass: false });
    if (mode === 'scheduledOnly')
      f.events[6]!.activityTaskCompletedEventAttributes!.scheduledEventId =
        temporal.api.history.v1.HistoryEvent.fromObject({ eventId: '3' }).eventId;
    if (mode === 'payloadLimit')
      f.events[0]!.workflowExecutionStartedEventAttributes!.input!.payloads![0]!.data = Buffer.alloc(
        ACCEPTANCE_HISTORY_LIMITS.payloadBytes + 1,
      );
    if (mode === 'changedDescribe')
      f.connection.workflowService.describeWorkflowExecution
        .mockImplementationOnce(async () => structuredClone(f.describe))
        .mockImplementationOnce(
          async () =>
            ({
              ...f.describe,
              workflowExecutionInfo: {
                ...f.describe.workflowExecutionInfo,
                historyLength: temporal.api.history.v1.HistoryEvent.fromObject({ eventId: '9' }).eventId,
              },
            }) as typeof f.describe,
        );
    expect((await f.reader.read(id)).kind).toBe('unknown');
  });
  it.each([{ repo: 'o/another' }, { issueNumber: 999 }, { head: '0'.repeat(40) }, { prNumber: 999 }])(
    '精确仓/单/PR/head不匹配不能产生证明：%j',
    async (changed) => {
      expect((await fixture().reader.read({ ...id, ...changed })).kind).toBe('unknown');
    },
  );
  it('取消与迟到响应都停止后续RPC，不产生证明', async () => {
    const f = fixture(),
      controller = new AbortController();
    const abortContext = vi.spyOn(f.connection, 'withAbortSignal');
    const deadlines = vi.spyOn(f.connection, 'withDeadline');
    f.history.mockImplementationOnce(async () => {
      controller.abort();
      return f.pages[0]!;
    });
    expect(await f.reader.read(id, controller.signal)).toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(f.history).toHaveBeenCalledTimes(1);
    expect(abortContext).toHaveBeenCalledTimes(2);
    expect(abortContext.mock.calls.every(([signal]) => signal instanceof AbortSignal && signal.aborted)).toBe(
      true,
    );
    expect(deadlines.mock.calls.every(([deadline]) => deadline <= Date.now() + 5_000)).toBe(true);
    const g = fixture();
    controller.abort();
    expect(await g.reader.read(id, controller.signal)).toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(g.history).not.toHaveBeenCalled();
  });
  it('RPC失败不返回原文；传递真实deadline和abort context', async () => {
    const f = fixture();
    f.history.mockRejectedValueOnce(Error('private body'));
    expect(await f.reader.read(id)).toEqual({ kind: 'unknown', code: 'read_failed' });
  });
  it.each(['responseBytes', 'eventCount', 'pageCount', 'totalBytes', 'tokenBytes'])(
    '完整history的 %s 超限明确拒绝',
    async (mode) => {
      const f = fixture();
      if (mode === 'tokenBytes')
        f.pages[0]!.nextPageToken = Buffer.alloc(ACCEPTANCE_HISTORY_LIMITS.tokenBytes + 1);
      if (mode === 'eventCount')
        f.pages[0]!.history!.events = Array.from({ length: ACCEPTANCE_HISTORY_LIMITS.events + 1 }, (_, i) =>
          temporal.api.history.v1.HistoryEvent.fromObject({ eventId: String(i + 1), eventType: 5 }),
        );
      if (mode === 'responseBytes')
        f.events[1]!.activityTaskScheduledEventAttributes!.input = p(
          'x'.repeat(ACCEPTANCE_HISTORY_LIMITS.responseBytes),
        );
      if (mode === 'pageCount' || mode === 'totalBytes') {
        let n = 0;
        const large = p('x'.repeat(1024 * 1024));
        f.history.mockImplementation(async () => {
          n++;
          const event =
            n === 1
              ? f.events[0]!
              : temporal.api.history.v1.HistoryEvent.fromObject({
                  eventId: String(n),
                  eventType: 26,
                  workflowExecutionSignaledEventAttributes: {
                    signalName: 'irrelevant',
                    input: mode === 'totalBytes' ? large : undefined,
                  },
                });
          return temporal.api.workflowservice.v1.GetWorkflowExecutionHistoryResponse.create({
            history: { events: [event] },
            nextPageToken: Buffer.from(String(n)),
          });
        });
      }
      expect(await f.reader.read(id)).toEqual({ kind: 'unknown', code: 'limit' });
    },
  );
  it('读回迟到跨总截止，RPC返回也不能继续下一页', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(),
        initial = Date.now();
      f.history.mockImplementationOnce(async () => {
        vi.setSystemTime(initial + 31_000);
        await vi.advanceTimersByTimeAsync(31_000);
        return f.pages[0]!;
      });
      expect(await f.reader.read(id)).toEqual({ kind: 'unknown', code: 'deadline' });
      expect(f.history).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('无关binary/null结果不必解码，不能靠notes碰巧命中建立B来源', async () => {
    const f = fixture();
    f.events[4]!.activityTaskCompletedEventAttributes!.result = p({ pass: false, notes: 'B' });
    const r = await f.reader.read(id);
    expect(r.kind).toBe('observed');
    if (r.kind === 'observed') expect(r.proof.sources.flatMap((s) => s.items)).not.toContain('B');
  });
});
