import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import { type History, Worker } from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineBundle } from './support.ts';

// #3413：两份历史都录在修复前的 task-runtime.ts（1a272e77 的父提交 d84505dc）上，录法见同目录 README。
// stuck-before-fix 是卡死现场：放弃信号的工作流任务被按住时 runSegment 完成先进服务端，历史停在 WorkflowTaskStarted。
// abandon-mid-segment-before-fix 是同一阶段的正常放弃（活动还在跑），老代码当场 RequestCancel。
// 两份都没有 abandon-cancel-after-buffer 标记：重放走老分支，证明修复没有让在途老任务变僵尸。
const directory = fileURLToPath(new URL('./replay/abandon-buffered-3413/', import.meta.url));
const MARKER = Buffer.from(JSON.stringify({ id: 'abandon-cancel-after-buffer', deprecated: false })).toString(
  'base64',
);

type Event = {
  eventId?: string;
  activityTaskScheduledEventAttributes?: { activityType?: { name?: string } } | null;
  activityTaskStartedEventAttributes?: { scheduledEventId?: string } | null;
  activityTaskCompletedEventAttributes?: { scheduledEventId?: string } | null;
  activityTaskCancelRequestedEventAttributes?: { scheduledEventId?: string } | null;
  workflowExecutionSignaledEventAttributes?: { signalName?: string } | null;
  workflowTaskScheduledEventAttributes?: object | null;
  workflowTaskStartedEventAttributes?: object | null;
  workflowTaskCompletedEventAttributes?: object | null;
  workflowExecutionCompletedEventAttributes?: object | null;
};

function load(file: string, sha256: string, events: number) {
  const bytes = readFileSync(`${directory}${file}`);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
  const text = bytes.toString('utf8');
  expect(text).not.toContain(MARKER);
  // 原 History.toJSON 的 JSON：编号是字符串，按 JSON 形状读结构，重放时再转 ProtoJSON。
  const json = JSON.parse(text) as { events: Event[] };
  expect(json.events).toHaveLength(events);
  return { history: json as unknown as History, events: json.events };
}
/** 第二段 runSegment 的调度事件和紧跟其后的放弃信号。 */
function abandonAfterSecondSegment(events: Event[]) {
  const segments = events.filter(
    (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'runSegment',
  );
  expect(segments).toHaveLength(2);
  const segment = segments[1] as Event;
  const at = events.indexOf(segment);
  expect(events[at + 1]?.workflowExecutionSignaledEventAttributes?.signalName).toBe('taskAbandon');
  return { segment, after: events.slice(at + 2) };
}

let bundle: Awaited<ReturnType<typeof engineBundle>>;
beforeAll(async () => {
  bundle = await engineBundle();
}, 120_000);

describe('#3413 放弃遇被缓冲的 runSegment 完成：修复前的固定历史', { timeout: 60_000 }, () => {
  it('卡死现场：放弃任务开了没收，runSegment 既没完成也没取消，run 不收场', async () => {
    const { history, events } = load(
      'stuck-before-fix.history',
      'd3a1abf2a3cecfde510bf04b1bfd0eef5a71a8a6b00861e0af7e3bcb1eccd1e4',
      303,
    );
    const { segment, after } = abandonAfterSecondSegment(events);
    // 尾巴只有放弃信号排出的那一个工作流任务：Scheduled → Started，之后服务端什么都不写（不判任务超时、不收完成）。
    expect(after).toHaveLength(2);
    expect(after[0]?.workflowTaskScheduledEventAttributes).toBeTruthy();
    expect(after[1]?.workflowTaskStartedEventAttributes).toBeTruthy();
    const ofSegment = (e: Event) =>
      [
        e.activityTaskStartedEventAttributes,
        e.activityTaskCompletedEventAttributes,
        e.activityTaskCancelRequestedEventAttributes,
      ].some((a) => a?.scheduledEventId === segment.eventId);
    expect(events.some(ofSegment)).toBe(false);
    expect(events.some((e) => e.workflowExecutionCompletedEventAttributes)).toBe(false);
    await Worker.runReplayHistory({ workflowBundle: bundle }, JSON.parse(historyToJSON(history)));
  });

  it('正常放弃：老代码在放弃任务里当场取消 runSegment，现在的代码按无标记老分支重放得过', async () => {
    const { history, events } = load(
      'abandon-mid-segment-before-fix.history',
      '369ff4e3b5b376ce5edc1eefd2fefe8da1a79e14d237d6f8113feab96efd0b1f',
      330,
    );
    const { segment, after } = abandonAfterSecondSegment(events);
    // 放弃任务 Scheduled/Started/Completed 之后第一条命令就是取消第二段；没有 1ms 定时器。
    expect(after[2]?.workflowTaskCompletedEventAttributes).toBeTruthy();
    expect(after[3]?.activityTaskCancelRequestedEventAttributes?.scheduledEventId).toBe(segment.eventId);
    expect(events.at(-1)?.workflowExecutionCompletedEventAttributes).toBeTruthy();
    await Worker.runReplayHistory({ workflowBundle: bundle }, JSON.parse(historyToJSON(history)));
  });
});
