// 活动外壳：计时（排队、干活分开）、错误码过边界。用 MockActivityEnvironment，不起服务端。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it } from 'vitest';
import { createActivities, PORT_NAMES, TASK_ACTIVITY_NAMES } from '../src/activities.ts';
import { ACTIVITY_PROFILE, profileOptions } from '../src/activity-options.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { DEFAULT_LIMITS } from '../src/limits.ts';
import { type ActivityTiming, type EnginePorts, PortError } from '../src/ports.ts';
import { freshRepo } from './helpers.ts';

const quiet = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };

function envWith(info: Record<string, unknown> = {}, client?: unknown) {
  return new MockActivityEnvironment(
    {
      attempt: 1,
      workflowType: 'subtaskWorkflow',
      workflowExecution: { workflowId: 'wf-1', runId: 'run-1' },
      currentAttemptScheduledTimestampMs: Date.now(),
      ...info,
    } as never,
    { logger: quiet, ...(client ? { client: client as never } : {}) },
  );
}

const createWorktreeInput = {
  taskId: 't1',
  subtaskId: 's1',
  subtaskKey: 'a',
  repo: freshRepo(),
  branch: 'fleet/1-a',
};

describe('活动外壳', () => {
  it('活动表齐全：工作流会调的每个名字 worker 都挂上了（windsurf-dao#1422）', () => {
    const activities = createActivities(createFakeWorld().ports);
    expect(Object.keys(activities).sort()).toEqual(Object.keys(ACTIVITY_PROFILE).sort());
    expect(
      [
        ...PORT_NAMES,
        'canaryOpen',
        'canaryCheck',
        'probeAssignedRoute',
        'releaseReservation',
        ...TASK_ACTIVITY_NAMES,
      ].sort(),
    ).toEqual(Object.keys(ACTIVITY_PROFILE).sort());
  });

  it('每次尝试记一笔：排队（排进队列 → 开始）和干活（开始 → 结束）分开', async () => {
    const world = createFakeWorld({ delayMs: { createWorktree: 60 } });
    const activities = createActivities(world.ports);
    const scheduled = Date.now() - 1_000;
    await envWith({ currentAttemptScheduledTimestampMs: scheduled, attempt: 2 }).run(
      activities.createWorktree,
      createWorktreeInput,
    );
    const [entry] = world.timings as ActivityTiming[];
    expect(entry).toMatchObject({
      kind: 'activity',
      activity: 'createWorktree',
      attempt: 2,
      workflowId: 'wf-1',
      taskId: 't1',
      subtaskId: 's1',
      subtaskKey: 'a',
      outcome: 'ok',
    });
    expect(entry?.queueMs).toBeGreaterThanOrEqual(1_000);
    expect(entry?.queueMs).toBeLessThan(2_000);
    expect(entry?.runMs).toBeGreaterThanOrEqual(50);
    expect(entry?.runMs).toBeLessThan(1_000);
    expect(Date.parse(entry?.startedAt ?? '') - Date.parse(entry?.scheduledAt ?? '')).toBe(entry?.queueMs);
  });

  it('端口抛 PortError：错误码、能不能重试、明细原样过边界（B5）', async () => {
    const world = createFakeWorld();
    const ports: EnginePorts = {
      ...world.ports,
      createWorktree: async () => {
        throw new PortError('WORKFLOWS_PERMISSION', '机器人没有 workflows 权限', {
          retryable: false,
          details: { files: ['.github/workflows/ci.yml'] },
        });
      },
    };
    const error = await envWith()
      .run(createActivities(ports).createWorktree, createWorktreeInput)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicationFailure);
    const failure = error as ApplicationFailure;
    expect(failure.type).toBe('WORKFLOWS_PERMISSION');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.details).toEqual([{ files: ['.github/workflows/ci.yml'] }]);
    expect((world.timings[0] as ActivityTiming).outcome).toBe('failed');
    expect((world.timings[0] as ActivityTiming).errorCode).toBe('WORKFLOWS_PERMISSION');
  });

  it('记计时失败不连累活动本身', async () => {
    const world = createFakeWorld();
    const ports: EnginePorts = {
      ...world.ports,
      recordTiming: async () => {
        throw new Error('库连不上');
      },
    };
    const tree = (await envWith().run(createActivities(ports).createWorktree, createWorktreeInput)) as {
      branch: string;
    };
    expect(tree.branch).toBe('fleet/1-a');
  });

  it('被取消的记成 cancelled，取消原样往外抛', async () => {
    const world = createFakeWorld({ delayMs: { createWorktree: 5_000 } });
    const env = envWith();
    const running = env.run(createActivities(world.ports).createWorktree, createWorktreeInput);
    setTimeout(() => env.cancel(), 50);
    const error = await running.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledFailure);
    expect((world.timings[0] as ActivityTiming).outcome).toBe('cancelled');
  });

  it('超时按活动类型分开：记账类 30 秒、推分支开 PR 这类 5 分钟，长活动都带心跳（没有一刀切的 74 分钟）', () => {
    const quick = profileOptions(ACTIVITY_PROFILE.recordTiming, DEFAULT_LIMITS);
    expect(quick.startToCloseTimeout).toBe('30 seconds');
    expect(quick.heartbeatTimeout).toBeUndefined();
    expect(profileOptions(ACTIVITY_PROFILE.openPr, DEFAULT_LIMITS).startToCloseTimeout).toBe('5 minutes');
    const long = ['waitCi', 'createWorktree'] as const;
    for (const name of long) {
      expect(profileOptions(ACTIVITY_PROFILE[name], DEFAULT_LIMITS).heartbeatTimeout, name).toBe(
        '120 seconds',
      );
    }
    expect(profileOptions(ACTIVITY_PROFILE.waitCi, DEFAULT_LIMITS).startToCloseTimeout).toBe('40 minutes');
    // 要人的错误码不白白重试。
    expect(quick.retry?.nonRetryableErrorTypes).toContain('WORKFLOWS_PERMISSION');
    // 放预占是短的、幂等的删除，不占探测那一档 10 分钟。
    expect(profileOptions(ACTIVITY_PROFILE.releaseReservation, DEFAULT_LIMITS).startToCloseTimeout).toBe(
      '30 seconds',
    );
  });

  it('没装路由探针：派前探测报 JOB_NOT_CONFIGURED，不当成探通', async () => {
    const activities = createActivities(createFakeWorld().ports);
    const error = await envWith()
      .run(activities.probeAssignedRoute, {
        schemaVersion: 1 as const,
        routeId: 'r1',
        label: 'glm-5.3-flash',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicationFailure);
    const failure = error as ApplicationFailure;
    expect(failure.type).toBe('JOB_NOT_CONFIGURED');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).toContain('没装路由探针');
    expect(failure.message).not.toContain('探通');
  });

  it('没装放预占：报 JOB_NOT_CONFIGURED，不装作放过', async () => {
    const activities = createActivities(createFakeWorld().ports);
    const error = await envWith()
      .run(activities.releaseReservation, { schemaVersion: 1 as const, reservationId: 'res-1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicationFailure);
    const failure = error as ApplicationFailure;
    expect(failure.type).toBe('JOB_NOT_CONFIGURED');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).toContain('没装放预占');
  });

  it('放预占：交给装配的回调，回 released', async () => {
    const released: string[] = [];
    const activities = createActivities(createFakeWorld().ports, {
      releaseReservation: async (id) => {
        released.push(id);
      },
    });
    const got = await envWith().run(activities.releaseReservation, {
      schemaVersion: 1 as const,
      reservationId: 'res-1',
    });
    expect(got).toEqual({ released: true });
    expect(released).toEqual(['res-1']);
  });
});

describe('【故意造出的失败】生产装配漏接派前探测放预占（#1409）', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/real/index.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('jobs.releaseReservation 交给 reservations.release', () => {
    expect(source).toMatch(
      /jobs\.releaseReservation = \(reservationId\) => reservations\.release\(reservationId\)/,
    );
  });

  it('检查本身有牙：拿掉这一行，同一个检查会红', () => {
    const without = source.replace(
      'jobs.releaseReservation = (reservationId) => reservations.release(reservationId);',
      '',
    );
    expect(without).not.toBe(source);
    expect(without).not.toMatch(
      /jobs\.releaseReservation = \(reservationId\) => reservations\.release\(reservationId\)/,
    );
  });
});
