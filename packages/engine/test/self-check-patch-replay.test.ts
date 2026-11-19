// #3258：self-check-own-timeout 和 limits 的本地活动被查询拆进相邻两个 workflow task 时，重放对不上。
// 两份都是修复前的真历史，不许用修好的代码重录覆盖。
// 跨任务那份是 #3413 停在查停点时留下的 protobuf（和 route-wake 隔离复现是同一种切开：
// 本地活动标记在前一个任务，补丁标记在后一个任务）。工作区里没有那次 route-wake 的原字节。
// 同行是修复前的任务工作流真跑出来的：本地活动和补丁在同一个任务里。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import { Worker } from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineBundle } from './support.ts';

const requireFromCommon = createRequire(
  fileURLToPath(import.meta.resolve('@temporalio/common/lib/proto-utils.js')),
);
const History = (
  requireFromCommon('@temporalio/proto') as {
    temporal: {
      api: {
        history: {
          v1: {
            History: {
              decode(bytes: Uint8Array): { events?: Event[] };
            };
          };
        };
      };
    };
  }
).temporal.api.history.v1.History;

type Event = {
  eventId?: string | number;
  markerRecordedEventAttributes?: {
    markerName?: string;
    workflowTaskCompletedEventId?: string | number;
    details?: { 'patch-data'?: { payloads?: { data?: string | Uint8Array }[] } };
  } | null;
};

const SPLIT_SHA256 = '6631d578fbdfd6237721ba8d93508c415707c3fbcdfc670b24b6738fcdd43f48';
const SPLIT_WORKFLOW_ID = 'handback-0c8f4322-17be-4b14-9e92-c81f0514e949';
const SAME_SHA256 = 'a4a67ac5f29141ca34395523cd80335ea4831d5f75c7ac7332734a2bf5046b43';
const SAME_WORKFLOW_ID = 'task:acme/demo-b8044cf0#3258';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function patchId(event: Event): string | undefined {
  const data = event.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0]?.data;
  if (data === undefined) return undefined;
  const bytes =
    typeof data === 'string'
      ? Buffer.from(data, data.startsWith('{') ? 'utf8' : 'base64')
      : Buffer.from(data);
  const json = JSON.parse(bytes.toString('utf8')) as { id?: string };
  return json.id;
}

function markerTask(events: Event[], name: string, id?: string): string {
  const found = events.find((event) => {
    const marker = event.markerRecordedEventAttributes;
    if (marker?.markerName !== name) return false;
    return id === undefined || patchId(event) === id;
  });
  const task = found?.markerRecordedEventAttributes?.workflowTaskCompletedEventId;
  if (task === undefined) throw new Error(`没有 ${name} 标记`);
  return String(task);
}

async function replay(bytes: Uint8Array, workflowId: string): Promise<void> {
  const decoded = History.decode(bytes);
  await Worker.runReplayHistory(
    { workflowBundle: bundle },
    JSON.parse(historyToJSON(decoded as unknown as Parameters<typeof historyToJSON>[0])),
    workflowId,
  );
}

let bundle: Awaited<ReturnType<typeof engineBundle>>;
beforeAll(async () => {
  bundle = await engineBundle();
}, 120_000);

describe('self-check-own-timeout 跨任务与同行', { timeout: 60_000 }, () => {
  it('跨 workflow task：本地活动和补丁不在同一个任务，原字节重放通过', async () => {
    const bytes = readFileSync(
      fileURLToPath(
        new URL('./replay/worker-replacement-3413/park-query-timeout.history.bin', import.meta.url),
      ),
    );
    expect(sha256(bytes)).toBe(SPLIT_SHA256);
    const events = History.decode(bytes).events ?? [];
    expect(markerTask(events, 'core_local_activity')).not.toBe(
      markerTask(events, 'core_patch', 'self-check-own-timeout'),
    );
    await replay(bytes, SPLIT_WORKFLOW_ID);
  });

  it('同行：本地活动和补丁在同一个任务，原字节重放通过', async () => {
    const bytes = readFileSync(
      fileURLToPath(new URL('./replay/route-wake-3258/same-task.history.bin', import.meta.url)),
    );
    expect(sha256(bytes)).toBe(SAME_SHA256);
    const events = History.decode(bytes).events ?? [];
    const task = markerTask(events, 'core_local_activity');
    expect(markerTask(events, 'core_patch', 'self-check-own-timeout')).toBe(task);
    await replay(bytes, SAME_WORKFLOW_ID);
  });
});
