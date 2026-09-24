// 活动外壳：计时（排队、干活分开）、错误码过边界、起会话前现签通行证。用 MockActivityEnvironment，不起服务端。
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it } from 'vitest';
import { agentTokenTtlSeconds, createActivities, PORT_NAMES } from '../src/activities.ts';
import { ACTIVITY_PROFILE, profileOptions } from '../src/activity-options.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { DEFAULT_LIMITS } from '../src/limits.ts';
import { type ActivityTiming, type EnginePorts, PortError, type StartSessionInput } from '../src/ports.ts';
import { freshRepo } from './helpers.ts';

const launch = {
  fleetApi: 'http://127.0.0.1:8788',
  cliBinDir: '/repo/packages/cli/bin',
  signToken: (c: { taskId: string; runId: string; ttlSeconds: number; subtaskId?: string }) =>
    `t:${c.taskId}:${c.subtaskId ?? '-'}:${c.runId}:${c.ttlSeconds}`,
};

const quiet = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };

function envWith(info: Record<string, unknown> = {}) {
  return new MockActivityEnvironment(
    {
      attempt: 1,
      workflowType: 'subtaskWorkflow',
      workflowExecution: { workflowId: 'wf-1', runId: 'run-1' },
      currentAttemptScheduledTimestampMs: Date.now(),
      ...info,
    } as never,
    { logger: quiet },
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
    const activities = createActivities(createFakeWorld().ports, launch);
    expect(Object.keys(activities).sort()).toEqual(Object.keys(ACTIVITY_PROFILE).sort());
    expect([...PORT_NAMES, 'enqueueMerge'].sort()).toEqual(Object.keys(ACTIVITY_PROFILE).sort());
  });

  it('每次尝试记一笔：排队（排进队列 → 开始）和干活（开始 → 结束）分开', async () => {
    const world = createFakeWorld({ delayMs: { createWorktree: 60 } });
    const activities = createActivities(world.ports, launch);
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
      .run(createActivities(ports, launch).createWorktree, createWorktreeInput)
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
    const tree = (await envWith().run(
      createActivities(ports, launch).createWorktree,
      createWorktreeInput,
    )) as {
      branch: string;
    };
    expect(tree.branch).toBe('fleet/1-a');
  });

  it('被取消的记成 cancelled，取消原样往外抛', async () => {
    const world = createFakeWorld({ delayMs: { createWorktree: 5_000 } });
    const env = envWith();
    const running = env.run(createActivities(world.ports, launch).createWorktree, createWorktreeInput);
    setTimeout(() => env.cancel(), 50);
    const error = await running.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledFailure);
    expect((world.timings[0] as ActivityTiming).outcome).toBe('cancelled');
  });

  it('起会话：worker 按这次会话现签通行证、把 fleet 命令放进 PATH；工作流给的入参里没有通行证', async () => {
    const world = createFakeWorld();
    const input: StartSessionInput = {
      taskId: 't1',
      subtaskId: 's1',
      subtaskKey: 'a',
      runId: 'run-uuid',
      stage: 'execute',
      route: { routeId: 'r1', poolId: 'p1', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
      whyRoute: '排第一',
      queuedAt: new Date().toISOString(),
      brief: { title: 'x', request: 'x', acceptance: [], touches: [], feedback: [], answers: [] },
      stallSeconds: 360,
      sessionMinutes: 90,
      resources: { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 },
    };
    await envWith().run(createActivities(world.ports, launch).startSession, input);
    const call = world.callsOf('startSession')[0];
    expect(call?.input.launch).toEqual({
      fleetApi: 'http://127.0.0.1:8788',
      fleetToken: `t:t1:s1:run-uuid:${agentTokenTtlSeconds(90)}`,
      pathPrepend: ['/repo/packages/cli/bin'],
    });
    expect('launch' in input).toBe(false);
  });

  it('没配 fleet 命令的后端地址：不起会话，报 CONFIG_MISSING（不可重试，失败分流直接挂起报警）', async () => {
    const world = createFakeWorld();
    const error = await envWith()
      .run(createActivities(world.ports, { ...launch, fleetApi: '' }).startSession, {
        taskId: 't1',
        runId: 'r',
        stage: 'execute',
        route: { routeId: 'r1', poolId: 'p1', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
        whyRoute: 'x',
        queuedAt: new Date().toISOString(),
        brief: { title: 'x', request: 'x', acceptance: [], touches: [], feedback: [], answers: [] },
        stallSeconds: 360,
        sessionMinutes: 90,
        resources: { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 },
      } satisfies StartSessionInput)
      .catch((e: unknown) => e);
    expect((error as ApplicationFailure).type).toBe('CONFIG_MISSING');
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect(world.count('startSession')).toBe(0);
  });

  it('超时按活动类型分开：记账类 30 秒、推分支开 PR 这类 5 分钟，长活动都带心跳（没有一刀切的 74 分钟）', () => {
    const quick = profileOptions(ACTIVITY_PROFILE.recordTiming, DEFAULT_LIMITS);
    expect(quick.startToCloseTimeout).toBe('30 seconds');
    expect(quick.heartbeatTimeout).toBeUndefined();
    expect(profileOptions(ACTIVITY_PROFILE.openPr, DEFAULT_LIMITS).startToCloseTimeout).toBe('5 minutes');
    const long = ['awaitSession', 'waitCi', 'runTests', 'createWorktree'] as const;
    for (const name of long) {
      expect(profileOptions(ACTIVITY_PROFILE[name], DEFAULT_LIMITS).heartbeatTimeout, name).toBe(
        '120 seconds',
      );
    }
    expect(profileOptions(ACTIVITY_PROFILE.awaitSession, DEFAULT_LIMITS).startToCloseTimeout).toBe(
      '90 minutes',
    );
    // 要人的错误码不白白重试。
    expect(quick.retry?.nonRetryableErrorTypes).toContain('WORKFLOWS_PERMISSION');
  });

  it('通行证比会话限时多一刻钟，最长一天', () => {
    expect(agentTokenTtlSeconds(90)).toBe(105 * 60);
    expect(agentTokenTtlSeconds(10_000)).toBe(24 * 60 * 60);
  });
});
