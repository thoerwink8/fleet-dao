import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  answerSignal,
  pauseSignal,
  resumeSignal,
  type SubtaskResult,
  type SubtaskStatus,
  stopSignal,
  WORKFLOW_TYPES,
} from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import type { ActivityTiming, AwaitSessionInput, StartSessionInput } from '../src/ports.ts';
import { historyText, queryUntil, spec, subtaskInput, useEnv, waitUntil, withWorker } from './helpers.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

const startSubtask = (taskQueue: string, input = subtaskInput(spec('a'))) =>
  env.client.workflow.start(WORKFLOW_TYPES.subtask, {
    taskQueue,
    workflowId: `sub-test-${input.taskId}`,
    args: [input],
  });

describe('子任务工作流', { timeout: 60_000 }, () => {
  it('顺利走完：建树 → 写码 → 引擎推分支、开 PR → 同步主线 → CI ∥ 第二意见 → 合并队列 → 收树', async () => {
    const world = createFakeWorld();
    const input = subtaskInput(spec('a'));
    const result = await withWorker(env, world, async (q) => {
      const handle = await startSubtask(q, input);
      return (await handle.result()) as SubtaskResult;
    });
    expect(result.state).toBe('merged');
    expect(result.subtaskId).toBe(input.subtaskId);
    expect(result.prNumber).toBe(100);
    expect(result.mergeCommit).toBe('mc-100-1');
    const order = world.calls.filter((c) => c.port !== 'recordTiming').map((c) => c.port);
    expect(order.slice(0, 6)).toEqual([
      'createWorktree',
      'pickRoute',
      'startSession',
      'awaitSession',
      'pushBranch',
      'openPr',
    ]);
    expect(order).toContain('waitCi');
    expect(world.callsOf('startSession').map((c) => c.input.stage)).toEqual(['execute', 'review']);
    // 合并队列里：同步主线 → 在新头上跑测试 → 带头约束合并。
    const mqOrder = order.slice(order.indexOf('runTests') - 1);
    expect(mqOrder.slice(0, 3)).toEqual(['syncMainline', 'runTests', 'mergePr']);
    expect(world.callsOf('removeWorktree').map((c) => c.input.archive)).toEqual([false]);
  });

  it('起会话：每次一个新的 runId，worker 现签只对这次会话有效的通行证、把 fleet 命令放进 PATH、给停滞超时', async () => {
    const world = createFakeWorld();
    const input = subtaskInput(spec('a'));
    await withWorker(env, world, async (q) => (await startSubtask(q, input)).result());
    const starts = world.callsOf('startSession');
    expect(starts).toHaveLength(2);
    const runIds = starts.map((c) => c.input.runId);
    expect(new Set(runIds).size).toBe(2);
    for (const call of starts) {
      const { runId, launch, stallSeconds, subtaskId, taskId, resources } = call.input;
      expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(subtaskId).toBe(input.subtaskId);
      expect(launch.fleetToken).toBe(`token:${taskId}:${input.subtaskId}:${runId}:${90 * 60 + 15 * 60}`);
      expect(launch.pathPrepend).toEqual(['/repo/packages/cli/bin']);
      expect(launch.fleetApi).toBe('http://127.0.0.1:8788');
      expect(stallSeconds).toBe(360);
      // 内存上限连 swap 一起封。
      expect(resources).toEqual({ memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 });
    }
    // 写码会话带上起会话前的头（交付判据用）；审查会话不带。
    expect(starts.map((c) => c.input.baseHead)).toEqual(['base', undefined]);
    // 插头报上来的进程号、scope 记在工作流里，看守拿着它（工人重启后靠它找回旧会话）。
    const watches = world.callsOf('awaitSession');
    expect(watches.map((c) => c.input.handle?.scope)).toEqual(runIds.map((id) => `fleet-agent-${id}.scope`));
    // 通行证只在活动里现签，不进工作流历史（历史里的载荷解码后逐字查）。
    const history = await env.client.workflow.getHandle(`sub-test-${input.taskId}`).fetchHistory();
    const text = historyText(history);
    expect(text).toContain(runIds[0]);
    expect(text).not.toContain('token:');
  });

  it('每次活动尝试都记了排队和干活两段时间', async () => {
    const world = createFakeWorld();
    await withWorker(env, world, async (q) => (await startSubtask(q)).result());
    const activities = world.timings.filter((t): t is ActivityTiming => t.kind === 'activity');
    const names = new Set(activities.map((t) => t.activity));
    for (const name of [
      'createWorktree',
      'startSession',
      'awaitSession',
      'openPr',
      'waitCi',
      'mergePr',
      'enqueueMerge',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    for (const t of activities) {
      expect(t.queueMs).toBeGreaterThanOrEqual(0);
      expect(t.runMs).toBeGreaterThanOrEqual(0);
      expect(Date.parse(t.endedAt) - Date.parse(t.startedAt)).toBe(t.runMs);
      expect(t.outcome).toBe('ok');
    }
    expect(activities.find((t) => t.activity === 'createWorktree')?.subtaskKey).toBe('a');
  });

  it('流程判断结果记在历史里（本地活动 decide 的记录），重放不重算', async () => {
    const world = createFakeWorld();
    const history = await withWorker(env, world, async (q) => {
      const handle = await startSubtask(q);
      await handle.result();
      return handle.fetchHistory();
    });
    const markers = (history.events ?? []).filter((e) => e.markerRecordedEventAttributes);
    // limits、verify 至少各一次。
    expect(markers.length).toBeGreaterThanOrEqual(2);
  });

  it('会话结局记进库：用量是执行体累计值和上一轮的差（续会话时不重复算）', async () => {
    const world = createFakeWorld({
      review: (_input, n) =>
        n === 1 ? { verdict: 'changes', findings: [{ severity: 'blocking', text: '漏了过期' }] } : undefined,
    });
    await withWorker(env, world, async (q) => (await startSubtask(q)).result());
    const runs = world.timings.filter((t) => t.kind === 'session');
    const execs = runs.filter((r) => r.stage === 'execute');
    // 写码会话跑了两次（第二次是续上同一个会话返工）：累计 100 → 200，这一次的都是 100。
    expect(execs.map((r) => [r.outcome, r.usageTotal.inputTokens, r.usage.inputTokens])).toEqual([
      ['ok', 100, 100],
      ['ok', 200, 100],
    ]);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(runs.length);
  });

  it('暂停：会话停在干净的点，继续后续上同一个会话', async () => {
    const world = createFakeWorld({
      session: (input, n) => (input.stage === 'execute' && n === 1 ? { hold: true } : {}),
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startSubtask(q);
      await waitUntil(() => world.held().length === 1, '写码会话挂着');
      await handle.signal(pauseSignal, { by: 'founder' });
      const paused = await queryUntil<SubtaskStatus>(
        handle,
        (s) => s.waiting?.kind === 'human',
        '暂停后在等人',
      );
      expect(paused.paused).toBe(true);
      expect(paused.waiting?.detail).toContain('暂停');
      expect(world.callsOf('stopSession').map((c) => c.input.mode)).toEqual(['graceful']);
      await handle.signal(resumeSignal, { by: 'founder' });
      // 不在暂停时再发「继续」：明确拒绝，不静默丢弃。
      const done = (await handle.result()) as SubtaskResult;
      return { done, status: (await handle.query('status')) as SubtaskStatus };
    });
    expect(result.done.state).toBe('merged');
    const starts = world.callsOf('startSession').filter((c) => c.input.stage === 'execute');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.input.resumeSessionId).toBe('s1');
    expect(result.status.commands.map((c) => [c.command, c.accepted])).toEqual([
      ['pause', true],
      ['resume', true],
    ]);
  });

  it('不在暂停也不在挂起时收到「继续」：回执里写明忽略', async () => {
    const world = createFakeWorld({
      session: (input, n) => (input.stage === 'execute' && n === 1 ? { hold: true } : {}),
    });
    const status = await withWorker(env, world, async (q) => {
      const handle = await startSubtask(q);
      await waitUntil(() => world.held().length === 1, '写码会话挂着');
      await handle.signal(resumeSignal, { by: 'founder' });
      const s = await queryUntil<SubtaskStatus>(handle, (x) => x.commands.length === 1, '回执');
      world.release('s1');
      await handle.result();
      return s;
    });
    expect(status.commands[0]).toMatchObject({ command: 'resume', accepted: false, by: 'founder' });
  });

  it('叫停：停会话、收树（先存档），以 stopped 结束，不进合并队列', async () => {
    const world = createFakeWorld({ session: (input) => (input.stage === 'execute' ? { hold: true } : {}) });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startSubtask(q);
      await waitUntil(() => world.held().length === 1, '写码会话挂着');
      await handle.signal(stopSignal, { by: 'founder', reason: '不做了' });
      return (await handle.result()) as SubtaskResult;
    });
    expect(result.state).toBe('stopped');
    expect(world.callsOf('stopSession').map((c) => c.input.mode)).toEqual(['kill']);
    expect(world.callsOf('removeWorktree').map((c) => c.input.archive)).toEqual([true]);
    expect(world.count('mergePr')).toBe(0);
  });

  it('交付对账：改的文件和方案点名的地方一个都对不上，不推不验，回主会话重做', async () => {
    const world = createFakeWorld({
      session: (input, n) =>
        input.stage === 'execute' && n === 1
          ? {
              output: {
                kind: 'delivery',
                head: 'off-1',
                summary: '改了别处',
                testsPassed: true,
                changedFiles: ['docs/unrelated.md'],
              },
            }
          : {},
    });
    const result = (await withWorker(env, world, async (q) =>
      (await startSubtask(q)).result(),
    )) as SubtaskResult;
    expect(result.state).toBe('merged');
    const execs = world.callsOf('startSession').filter((c) => c.input.stage === 'execute');
    expect(execs).toHaveLength(2);
    expect(execs[1]?.input.brief.feedback[0]?.summary).toContain('对不上');
    // 对不上的那次没推上去。
    expect(world.callsOf('pushBranch').map((c) => c.input.head)).not.toContain('off-1');
  });

  it('会话说要人回答：在任务里问，回答到了续上同一个会话，带着回答接着干', async () => {
    const world = createFakeWorld({
      session: (input, n) =>
        input.stage === 'execute' && n === 1
          ? { outcome: 'blocked', blocked: { question: '验证码几位？', options: ['4 位', '6 位'] } }
          : {},
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startSubtask(q);
      const asking = await queryUntil<SubtaskStatus>(handle, (s) => Boolean(s.waiting?.askId), '在等回答');
      expect(asking.waiting?.detail).toContain('验证码几位？');
      await handle.signal(answerSignal, {
        by: 'founder',
        askId: asking.waiting?.askId ?? '',
        answer: '6 位',
      });
      return (await handle.result()) as SubtaskResult;
    });
    expect(result.state).toBe('merged');
    expect(world.callsOf('askHuman')[0]?.input).toMatchObject({
      question: '验证码几位？',
      options: ['4 位', '6 位'],
    });
    const execs = world.callsOf('startSession').filter((c) => c.input.stage === 'execute');
    expect(execs[1]?.input.resumeSessionId).toBe('s1');
    expect(execs[1]?.input.brief.answers).toEqual([{ question: '验证码几位？', answer: '6 位' }]);
  });

  it('不认识的命令不静默丢：回执里写明忽略', async () => {
    const world = createFakeWorld({
      session: (input, n) => (input.stage === 'execute' && n === 1 ? { hold: true } : {}),
    });
    const status = await withWorker(env, world, async (q) => {
      const handle = await startSubtask(q);
      await waitUntil(() => world.held().length === 1, '写码会话挂着');
      await handle.signal('approve', { by: 'founder' });
      const s = await queryUntil<SubtaskStatus>(handle, (x) => x.commands.length === 1, '回执');
      world.release('s1');
      await handle.result();
      return s;
    });
    expect(status.commands[0]).toMatchObject({ command: 'approve', accepted: false });
  });

  it('活动失败先按活动自己的重试来：建树失败两次，第三次成功', async () => {
    const world = createFakeWorld({ failFirst: { createWorktree: 2 } });
    const result = await withWorker(env, world, async (q) => (await startSubtask(q)).result());
    expect((result as SubtaskResult).state).toBe('merged');
    expect(world.callsOf('createWorktree').map((c) => [c.attempt, c.ok])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  it('会话失败按兜底梯走：路由繁忙 → 换路由；认不出的错 → 重试；都不停下等人', async () => {
    const world = createFakeWorld({
      session: (input, n) => {
        if (input.stage !== 'execute') return {};
        if (n === 1) return { outcome: 'failed', failure: { code: 'ROUTE_BUSY', message: '繁忙' } };
        if (n === 2) return { outcome: 'failed', failure: { code: 'WEIRD', message: '没见过的错' } };
        return {};
      },
    });
    const result = (await withWorker(env, world, async (q) =>
      (await startSubtask(q)).result(),
    )) as SubtaskResult;
    expect(result.state).toBe('merged');
    const execs = world.callsOf('startSession').filter((c) => c.input.stage === 'execute');
    expect(execs.map((c) => (c.input as StartSessionInput).route.routeId)).toEqual(['r1', 'r2', 'r2']);
    const picks = world.callsOf('pickRoute').filter((c) => c.input.stage === 'execute');
    expect(picks[1]?.input.avoidRouteIds).toEqual(['r1']);
    expect(world.count('raiseAlert')).toBe(0);
  });

  it('工人丢了：长活动靠心跳超时在秒级发现并重试接上，不等整段限时', async () => {
    const world = createFakeWorld({
      session: (input) => (input.stage === 'execute' ? { loseFirstWatch: true } : {}),
    });
    const result = (await withWorker(env, world, async (q) =>
      (await startSubtask(q, subtaskInput(spec('a'), { limits: { heartbeatSeconds: 2 } }))).result(),
    )) as SubtaskResult;
    expect(result.state).toBe('merged');
    const watches = world
      .callsOf('awaitSession')
      .filter((c) => (c.input as AwaitSessionInput).stage === 'execute');
    expect(watches.map((c) => c.attempt)).toEqual([1, 2]);
    const gap = (watches[1]?.at ?? 0) - (watches[0]?.at ?? 0);
    // 心跳超时 2 秒；会话限时是 90 分钟——几秒内接上就说明靠的是心跳。
    expect(gap).toBeGreaterThan(1_000);
    expect(gap).toBeLessThan(15_000);
  });

  it('兜底梯走到底：挂起并报警，人发「继续」后接着干', async () => {
    const world = createFakeWorld({
      session: (input, n) =>
        input.stage === 'execute' && n === 1
          ? { outcome: 'failed', failure: { code: 'PERMISSION_DENIED', message: '没权限', retryable: false } }
          : {},
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startSubtask(q);
      const parked = await queryUntil<SubtaskStatus>(handle, (s) => s.parked, '挂起');
      expect(parked.waiting?.kind).toBe('human');
      expect(world.count('raiseAlert')).toBe(1);
      await handle.signal(resumeSignal, { by: 'founder' });
      return (await handle.result()) as SubtaskResult;
    });
    expect(result.state).toBe('merged');
  });

  it('第二意见打回：意见回主会话（续上同一个会话），再审通过', async () => {
    const world = createFakeWorld({
      review: (_input, n) =>
        n === 1
          ? { verdict: 'changes', findings: [{ severity: 'blocking', text: '验证码没设过期时间' }] }
          : undefined,
    });
    const result = (await withWorker(env, world, async (q) =>
      (await startSubtask(q)).result(),
    )) as SubtaskResult;
    expect(result.state).toBe('merged');
    expect(result.rounds.review).toBe(1);
    const execs = world.callsOf('startSession').filter((c) => c.input.stage === 'execute');
    expect(execs).toHaveLength(2);
    expect(execs[1]?.input.resumeSessionId).toBe(execs[0] ? 's1' : undefined);
    expect(execs[1]?.input.brief.feedback[0]?.kind).toBe('review');
    // 第二意见每轮都是全新会话。
    const reviews = world.callsOf('startSession').filter((c) => c.input.stage === 'review');
    expect(reviews.map((c) => c.input.resumeSessionId)).toEqual([undefined, undefined]);
  });

  it('第二意见连续两轮提同一条必须改：不开第三轮，挂起交人', async () => {
    const world = createFakeWorld({
      review: () => ({
        verdict: 'changes',
        findings: [{ severity: 'blocking', text: '验证码没设过期时间' }],
      }),
    });
    await withWorker(env, world, async (q) => {
      const handle = await startSubtask(q);
      const parked = await queryUntil<SubtaskStatus>(handle, (s) => s.parked, '挂起');
      expect(parked.lastProblem).toContain('同一条');
      expect(world.callsOf('startSession').filter((c) => c.input.stage === 'review')).toHaveLength(2);
      await handle.signal(stopSignal);
      await handle.result();
    });
  });

  it('合并队列在最新主线上测红了：退回主会话修，修完重新排队合并', async () => {
    const world = createFakeWorld({
      tests: (_input, n) => (n === 1 ? { passed: false, summary: '登录测试挂了' } : undefined),
    });
    const result = (await withWorker(env, world, async (q) =>
      (await startSubtask(q)).result(),
    )) as SubtaskResult;
    expect(result.state).toBe('merged');
    expect(result.rounds.mergeReturn).toBe(1);
    const execs = world.callsOf('startSession').filter((c) => c.input.stage === 'execute');
    expect(execs[1]?.input.brief.feedback[0]).toMatchObject({ kind: 'merge-return' });
    expect(world.count('mergePr')).toBe(1);
  });

  // 这条要十来秒：测试服务端会把新任务派给已关掉的老工人留下的长轮询，合并队列的第一个工作流任务要等 10 秒超时才重派
  // （真服务端上工人停机会通知服务端，没有这 10 秒）。
  it('换了工人：停在暂停里的在途任务照样能查状态、收信号、走完', async () => {
    const world = createFakeWorld({
      session: (input, n) => (input.stage === 'execute' && n === 1 ? { hold: true } : {}),
    });
    const taskQueue = `swap-${Date.now()}`;
    const input = subtaskInput(spec('a'));
    await withWorker(
      env,
      world,
      async (q) => {
        const handle = await startSubtask(q, input);
        await waitUntil(() => world.held().length === 1, '写码会话挂着');
        await handle.signal(pauseSignal);
        await queryUntil<SubtaskStatus>(handle, (s) => s.waiting?.kind === 'human', '暂停后在等人');
      },
      { taskQueue, maxCachedWorkflows: 0 },
    );
    const result = await withWorker(
      env,
      world,
      async () => {
        const handle = env.client.workflow.getHandle(`sub-test-${input.taskId}`);
        const status = (await handle.query('status')) as SubtaskStatus;
        expect(status.paused).toBe(true);
        await handle.signal(resumeSignal);
        return (await handle.result()) as SubtaskResult;
      },
      { taskQueue, maxCachedWorkflows: 0 },
    );
    expect(result.state).toBe('merged');
    // 换工人不重做做过的事。
    expect(world.count('createWorktree')).toBe(1);
  });
});
