// #3413：worker replacement 原用例停在查停点的机制。
// 原字节（replay/worker-replacement-3413/）里第一个工作流任务只交了本地活动标记，同一毫秒又排了一个新任务，
// self-check-own-timeout 的补丁标记落在第二个任务里。SDK core 只在两种情况下这样强开新任务：
// 心跳（工作流任务超时的 80%），或回查询时手上还有没交给工作流的本地活动结果
// （@temporalio/core-bridge sdk-core/src/worker/workflow/managed_run.rs「pending LA resolutions … responding to a query」）。
// 重放时 core 往前看到下一个工作流任务为止，本地活动在第一个任务里就解了，工作流当场问补丁，
// 补丁标记却在再下一个任务里，于是 TMPRL1100（machines/workflow_machines.rs 的 lookahead 注释）。
// 不缓存的工人每个任务都重放，工作流就一直卡在失败重试；用例这时还在轮询查询，等到 20 秒/60 秒。
// 这里用真跑出来的历史，按原字节的形状（本地活动标记后强开一个任务）切开，确定地复现「切开 + 本地活动后问补丁 = 重放对不上」。
// 只钉机制，不修：task.ts/kit.ts 那条标记归 #3258。
import { fileURLToPath } from 'node:url';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundle } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv } from './support.ts';

type Event = { eventId: string; eventType: string } & Record<string, unknown>;
type History = { events: Event[] };

const silent = { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, log() {} };
let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;

beforeAll(async () => {
  [env, bundle] = await Promise.all([
    createEnv(),
    bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('./fixtures/la-query-split/workflows.ts', import.meta.url)),
      logger: silent as never,
    }),
  ]);
}, 120_000);
afterAll(async () => {
  await env?.teardown();
});

async function record(workflowType: string): Promise<{ workflowId: string; history: History }> {
  const taskQueue = `la-split-${workflowType}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities: { gate: async () => undefined, after: async () => undefined },
  });
  return worker.runUntil(async () => {
    const handle = await env.client.workflow.start(workflowType, {
      taskQueue,
      workflowId: `la-split-${workflowType}`,
    });
    await handle.result();
    const history = JSON.parse(historyToJSON(await handle.fetchHistory())) as History;
    return { workflowId: handle.workflowId, history };
  });
}

const attributes = (event: Event): Record<string, unknown> => {
  const key = Object.keys(event).find((k) => k.endsWith('EventAttributes'));
  if (!key) throw new Error(`event ${event.eventId} has no attributes`);
  return event[key] as Record<string, unknown>;
};
const isLocalActivityMarker = (event: Event) =>
  (event.markerRecordedEventAttributes as { markerName?: string } | undefined)?.markerName ===
  'core_local_activity';

/**
 * 按原字节的形状切开：第一个本地活动标记留在原工作流任务，紧接着强开一个工作流任务（排、开、交），
 * 原任务里排在标记之后的命令挪进新任务。其余事件原样，只重编号、改引用。
 */
function splitAfterLocalActivity(history: History): History {
  const events = history.events;
  const at = events.findIndex(isLocalActivityMarker);
  if (at < 0) throw new Error('no local activity marker');
  // 跳时间测试服务端的命令事件指向 started（原字节里标记 5 指向 3），真服务端指向 completed；照原样跟。
  const owner = attributes(events[at] as Event).workflowTaskCompletedEventId;
  // 同一任务里排在标记之前的命令（补丁在本地活动之前问时的补丁标记）留在原任务。
  let first = at;
  while (first > 0 && attributes(events[first - 1] as Event).workflowTaskCompletedEventId === owner) first--;
  const completed = events[first - 1],
    started = events[first - 2],
    scheduled = events[first - 3];
  if (
    completed?.eventType !== 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED' ||
    started?.eventType !== 'EVENT_TYPE_WORKFLOW_TASK_STARTED' ||
    scheduled?.eventType !== 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED'
  )
    throw new Error('local activity marker is not a command of a completed workflow task');
  let end = at + 1;
  while (end < events.length && attributes(events[end] as Event).workflowTaskCompletedEventId === owner)
    end++;
  const moved = events.slice(at + 1, end);
  if (!moved.length) throw new Error('nothing follows the local activity marker in its workflow task');

  const clone = (e: Event): Event => structuredClone(e);
  const forcedScheduled = clone(scheduled),
    forcedStarted = clone(started),
    forcedCompleted = clone(completed);
  const ordered = [
    ...events.slice(0, at + 1),
    forcedScheduled,
    forcedStarted,
    forcedCompleted,
    ...moved,
    ...events.slice(end),
  ];
  const renumber = new Map<string, string>();
  ordered.forEach((e, index) => {
    if (events.includes(e)) renumber.set(e.eventId, String(index + 1));
  });
  const id = (e: Event) => String(ordered.indexOf(e) + 1);
  const movedOwner = owner === started.eventId ? id(forcedStarted) : id(forcedCompleted);
  const firstMoved = ordered.indexOf(forcedCompleted) + 1;
  return {
    ...history,
    events: ordered.map((e, index) => {
      const out = events.includes(e) ? clone(e) : e;
      out.eventId = String(index + 1);
      const attrs = attributes(out);
      for (const [key, value] of Object.entries(attrs))
        if (key.endsWith('EventId') && typeof value === 'string' && renumber.has(value))
          attrs[key] = renumber.get(value);
      if (e === forcedStarted) attrs.scheduledEventId = id(forcedScheduled);
      if (e === forcedCompleted) {
        attrs.scheduledEventId = id(forcedScheduled);
        if ('startedEventId' in attrs) attrs.startedEventId = id(forcedStarted);
      }
      if (index >= firstMoved && index < firstMoved + moved.length)
        attrs.workflowTaskCompletedEventId = movedOwner;
      return out;
    }),
  };
}

const replay = (history: History, workflowId: string) =>
  Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId).then(
    () => undefined,
    (error: unknown) => error,
  );

describe('#3413 本地活动结果被查询隔到下一个工作流任务', { timeout: 60_000 }, () => {
  it('本地活动之后问补丁：没切开重放得过，切成原字节那样就报 TMPRL1100', async () => {
    const { workflowId, history } = await record('patchAfterLocal');
    expect(await replay(history, workflowId)).toBeUndefined();
    const split = splitAfterLocalActivity(history);
    const at = split.events.findIndex(isLocalActivityMarker);
    // 和原字节同形：本地活动标记后面紧跟新排的工作流任务，补丁标记落在新任务的命令里。
    expect(split.events.slice(at + 1, at + 4).map((e) => e.eventType)).toEqual([
      'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED',
      'EVENT_TYPE_WORKFLOW_TASK_STARTED',
      'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
    ]);
    expect((split.events[at + 4]?.markerRecordedEventAttributes as { markerName?: string })?.markerName).toBe(
      'core_patch',
    );
    const error = await replay(split, workflowId);
    expect(error).toBeInstanceOf(DeterminismViolationError);
    expect(String((error as Error).message)).toContain(
      '[TMPRL1100] Nondeterminism error: Non-deprecated patch marker encountered for change probe, but there is no corresponding change command!',
    );
  });

  it('对照：同样切开，本地活动之后只调普通活动、或补丁在本地活动之前问，重放都过', async () => {
    for (const type of ['plainAfterLocal', 'patchBeforeLocal']) {
      const { workflowId, history } = await record(type);
      const split = splitAfterLocalActivity(history);
      expect(split.events.length).toBe(history.events.length + 3);
      expect(await replay(split, workflowId)).toBeUndefined();
    }
  });
});
