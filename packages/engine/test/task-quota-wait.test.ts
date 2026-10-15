// 等额度且清零时刻在 28 小时后（#2329）：选路回的等待是上限那一档（QUOTA_ROUTE_WAIT_CAP_SECONDS，
// store-ports 把超过上限的 until 压到这里），工作流一次只起一个这么长的定时器。时间跳过后再选；
// 叫醒信号到了当场醒、重选，不睡满。
//
// 24 小时等额度的事件数：上限 4 小时 → 约 6 轮 × 约 9 条 ≈ 54 条（约 2 条/小时）。
// 现在每 120 秒一轮、约 270 条/小时、24 小时约 6480 条。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import type { PickRouteResult } from '../src/ports.ts';
import { QUOTA_ROUTE_WAIT_CAP_SECONDS } from '../src/real/store-ports.ts';
import {
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskRouteWakeSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

/** store-ports 在 until 超过上限时回的秒数。28 小时后的清零时刻走这一档，不是 120 秒。 */
const LONG_SECONDS = QUOTA_ROUTE_WAIT_CAP_SECONDS;
const WAIT_QUOTA: PickRouteResult = {
  ok: false,
  waitFor: 'quota',
  detail: '写码阶段暂时派不了，最早 28 小时后额度清零',
  retryAfterSeconds: LONG_SECONDS,
};

function input(): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    title: '给驾驶舱加状态',
  };
}

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber),
    args: [i],
  });
}

const waitingQuota = (h: WorkflowHandle) =>
  pollQuery(
    () => h.query<TaskStatus>(taskStatusQuery),
    (s) => s.waiting?.kind === 'quota',
    '工作流停在等额度',
  );

const wake = (h: WorkflowHandle) => h.signal(taskRouteWakeSignal, { by: 'test', reason: '切号完成' });

type HistEvent = {
  eventId?: unknown;
  timerStartedEventAttributes?: { startToFireTimeout?: unknown } | null;
  timerFiredEventAttributes?: { startedEventId?: unknown } | null;
  timerCanceledEventAttributes?: { startedEventId?: unknown } | null;
};

/** 历史里起过的定时器，start-to-fire 各是几秒（含已经响了的）。认不出时长就抛，不把空当成 0。 */
function startedTimerSeconds(events: readonly HistEvent[]): number[] {
  const started: number[] = [];
  for (const e of events) {
    if (!e.timerStartedEventAttributes) continue;
    started.push(timeoutSeconds(e.timerStartedEventAttributes.startToFireTimeout));
  }
  return started;
}

/** 定时器还没响、也没取消的，start-to-fire 是几秒。 */
function openTimerSeconds(events: readonly HistEvent[]): number[] {
  const done = new Set<string>();
  for (const e of events) {
    const id = e.timerFiredEventAttributes?.startedEventId ?? e.timerCanceledEventAttributes?.startedEventId;
    if (id != null) done.add(String(id));
  }
  const open: number[] = [];
  for (const e of events) {
    if (!e.timerStartedEventAttributes || done.has(String(e.eventId))) continue;
    open.push(timeoutSeconds(e.timerStartedEventAttributes.startToFireTimeout));
  }
  return open;
}

function timeoutSeconds(raw: unknown): number {
  if (typeof raw === 'string') {
    const secs = /^(\d+(?:\.\d+)?)s$/.exec(raw);
    if (secs?.[1]) return Number(secs[1]);
    const hours = /^(\d+(?:\.\d+)?)h$/.exec(raw);
    if (hours?.[1]) return Number(hours[1]) * 3600;
  }
  if (typeof raw === 'object' && raw !== null && 'seconds' in raw) {
    const seconds = (raw as { seconds: unknown }).seconds;
    if (typeof seconds === 'number' || typeof seconds === 'bigint') return Number(seconds);
    if (typeof seconds === 'string' && seconds !== '') return Number(seconds);
    if (typeof seconds === 'object' && seconds !== null && 'toNumber' in seconds) {
      return (seconds as { toNumber: () => number }).toNumber();
    }
  }
  throw new Error(`定时器时长认不出：${JSON.stringify(raw)}`);
}

describe('等额度按清零时刻长睡', { timeout: 60_000 }, () => {
  it('until 在 28 小时后：一次只起一个长定时器，时间跳过后再选', async () => {
    const world = createFakeWorld({ route: (_i, n) => (n === 1 ? WAIT_QUOTA : undefined) });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitingQuota(h);
        expect(world.count('pickRoute')).toBe(1);
        const events = ((await h.fetchHistory()).events ?? []) as HistEvent[];
        // 等着的时候只有这一个长定时器，没有 120 秒那档。
        expect(openTimerSeconds(events)).toEqual([LONG_SECONDS]);
        expect(startedTimerSeconds(events).filter((s) => s === 120)).toEqual([]);
        const t0 = await env.currentTimeMs();
        // 用带时长的 sleep 跳时。h.result() 会 unlockTimeSkipping 且不给时长，测试钟最多被拨 10 年，
        // 量出来的间隔不能拿来证明「只睡了 4 小时」。
        await env.sleep((LONG_SECONDS - 60) * 1000);
        expect(world.count('pickRoute')).toBe(1);
        expect((await env.currentTimeMs()) - t0).toBeLessThan(LONG_SECONDS * 1000);
        await env.sleep(120 * 1000);
        await world.until(() => world.count('pickRoute') >= 2, '长定时器到点后又选了一次路');
        const elapsed = (await env.currentTimeMs()) - t0;
        expect(elapsed).toBeGreaterThanOrEqual(LONG_SECONDS * 1000);
        expect(elapsed).toBeLessThan((LONG_SECONDS + 180) * 1000);
        expect(world.count('pickRoute')).toBe(2);
        const after = ((await h.fetchHistory()).events ?? []) as HistEvent[];
        expect(startedTimerSeconds(after).filter((s) => s === LONG_SECONDS)).toEqual([LONG_SECONDS]);
        expect(startedTimerSeconds(after).filter((s) => s === 120)).toEqual([]);
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
  });

  it('叫醒信号到了：当场醒重选，不睡满长定时器', async () => {
    const world = createFakeWorld({ route: (_i, n) => (n === 1 ? WAIT_QUOTA : undefined) });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        await waitingQuota(h);
        const events = ((await h.fetchHistory()).events ?? []) as HistEvent[];
        expect(openTimerSeconds(events)).toEqual([LONG_SECONDS]);
        const t0 = await env.currentTimeMs();
        await wake(h);
        await world.until(() => world.count('pickRoute') >= 2, '叫醒后又选了一次路');
        expect((await env.currentTimeMs()) - t0).toBeLessThan((LONG_SECONDS * 1000) / 2);
        expect(world.count('pickRoute')).toBe(2);
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
  });
});
