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
import { type ActivityTiming, type EnginePorts, type PortContext, PortError } from '../src/ports.ts';
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

describe.each(['createWorktree', 'coldVerify'] as const)('%s 的取消传播', (activity) => {
  function fixture() {
    const world = createFakeWorld();
    const env = envWith();
    const run = (
      handler: (input: unknown, ctx: PortContext) => Promise<never>,
      recordTiming = world.ports.recordTiming,
    ) => {
      const activities = createActivities(
        { ...world.ports, createWorktree: handler, recordTiming },
        {},
        { coldVerify: handler },
      );
      return activity === 'createWorktree'
        ? env.run(activities.createWorktree, createWorktreeInput)
        : env.run(activities.coldVerify, {
            schemaVersion: 1 as const,
            taskId: 't1',
            repo: freshRepo(),
            issueNumber: 3429,
            prNumber: 1,
            branch: 'local/3429-cancellation-reason',
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            what: '取消原因原样传播',
            howToFinish: ['保留 SDK 取消原因'],
            authorFamilies: [],
            round: 1 as const,
          });
    };
    return { world, env, run };
  }

  it.each([
    ['PortError', false],
    ['Error', false],
    ['PortError', true],
    ['Error', true],
  ] as const)('取消后包装成 %s，计时失败=%s，仍抛原 reason', async (kind, timingFails) => {
    const { world, env, run } = fixture();
    let reason: unknown;
    const error = await run(
      async (_input, ctx) => {
        env.cancel();
        reason = ctx.signal.reason;
        throw kind === 'PortError'
          ? new PortError('CONTRACT_UNVERIFIED', '正式合同未核实：CANCELLED', { retryable: true })
          : new Error('取消被包装');
      },
      async (entry, ctx) => {
        expect(ctx.signal.aborted).toBe(false);
        await world.ports.recordTiming(entry, ctx);
        if (timingFails) throw new Error('计时库不可用');
      },
    ).catch((e: unknown) => e);
    expect(reason).toBeInstanceOf(CancelledFailure);
    expect(error).toBe(reason);
    expect(error).toBeInstanceOf(CancelledFailure);
    expect(world.timings).toHaveLength(1);
    expect(world.timings[0]).toMatchObject({ activity, outcome: 'cancelled' });
    expect(world.timings[0]).not.toHaveProperty('errorCode');
  });

  it('handler 直接抛 SDK 取消 reason 时保持原引用', async () => {
    const { world, env, run } = fixture();
    let reason: unknown;
    const error = await run(async (_input, ctx) => {
      env.cancel();
      reason = ctx.signal.reason;
      ctx.signal.throwIfAborted();
      throw new Error('不可到达');
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledFailure);
    expect(error).toBe(reason);
    expect(world.timings).toHaveLength(1);
    expect(world.timings[0]).toMatchObject({ activity, outcome: 'cancelled' });
  });

  it('signal 未取消时直接抛 CancelledFailure，保持原实例和取消计时', async () => {
    const { world, run } = fixture();
    const original = new CancelledFailure('直接取消');
    const error = await run(async (_input, ctx) => {
      expect(ctx.signal.aborted).toBe(false);
      throw original;
    }).catch((e: unknown) => e);
    expect(error).toBe(original);
    expect(world.timings).toHaveLength(1);
    expect(world.timings[0]).toMatchObject({ activity, outcome: 'cancelled' });
  });

  it('未取消的普通错误保持原引用并记 failed', async () => {
    const { world, run } = fixture();
    const original = new Error('业务失败');
    const error = await run(async () => {
      throw original;
    }).catch((e: unknown) => e);
    expect(error).toBe(original);
    expect(world.timings).toHaveLength(1);
    expect(world.timings[0]).toMatchObject({ activity, outcome: 'failed', errorCode: 'Error' });
  });

  it('未取消的 PortError 保留重试策略和明细映射', async () => {
    const { world, run } = fixture();
    const error = await run(async () => {
      throw new PortError('CONTRACT_UNVERIFIED', '正式合同未核实', {
        retryable: true,
        details: { reason: '读取失败' },
      });
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error).toMatchObject({
      type: 'CONTRACT_UNVERIFIED',
      nonRetryable: false,
      details: [{ reason: '读取失败' }],
    });
    expect(world.timings).toHaveLength(1);
    expect(world.timings[0]).toMatchObject({
      activity,
      outcome: 'failed',
      errorCode: 'CONTRACT_UNVERIFIED',
    });
  });
});

describe('活动外壳', () => {
  it('execution 来源只读 SDK：跨 execution、重试和伪造 caller 不串源，缺 runId 保持未知（#3652）', async () => {
    const captured: PortContext[] = [];
    const world = createFakeWorld();
    const activities = createActivities({
      ...world.ports,
      createWorktree: async (input, context) => {
        captured.push(context);
        return world.ports.createWorktree(input, context);
      },
    });
    const forged = {
      ...createWorktreeInput,
      temporalRunId: 'forged',
      workflowExecution: { runId: 'forged' },
    };
    for (const execution of [
      { workflowId: 'wf-a', runId: 'execution-a' },
      { workflowId: 'wf-a', runId: 'execution-b' },
      { workflowId: 'wf-a' },
    ])
      await envWith({ workflowExecution: execution, attempt: 2 }).run(activities.createWorktree, forged);
    expect(captured.map((context) => [context.workflowId, context.temporalRunId])).toEqual([
      ['wf-a', 'execution-a'],
      ['wf-a', 'execution-b'],
      ['wf-a', undefined],
    ]);
  });
  it('活动表齐全：工作流会调的每个名字 worker 都挂上了（windsurf-dao#1422）', () => {
    const activities = createActivities(createFakeWorld().ports);
    expect(Object.keys(activities).sort()).toEqual(Object.keys(ACTIVITY_PROFILE).sort());
    expect(
      [...PORT_NAMES, 'probeAssignedRoute', 'releaseReservation', ...TASK_ACTIVITY_NAMES].sort(),
    ).toEqual(Object.keys(ACTIVITY_PROFILE).sort());
  });

  it('引擎启动代次是当前 worker 进程内稳定的时刻', async () => {
    const activities = createActivities(createFakeWorld().ports);
    const first = await envWith().run(activities.engineStartedAt, { schemaVersion: 1 as const });
    const second = await envWith().run(activities.engineStartedAt, { schemaVersion: 1 as const });
    expect(first).toMatchObject({ schemaVersion: 1, startedAt: expect.any(String) });
    expect(second).toEqual(first);
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
