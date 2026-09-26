// 假世界本身：测试靠它挑会话、等事情发生，这两样自己先得对（#88）。直接调端口，不起 Temporal。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeWorld } from '../src/fakes.ts';
import type { CloseIssueInput, LaunchSessionInput, PortContext } from '../src/ports.ts';

const ctx: PortContext = {
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
};

const launchInput = (subtaskKey: string | undefined, runId: string): LaunchSessionInput => ({
  taskId: 't1',
  ...(subtaskKey ? { subtaskId: `id-${subtaskKey}`, subtaskKey } : {}),
  runId,
  stage: 'execute',
  route: { routeId: 'r1', poolId: 'p1', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
  whyRoute: '排第一',
  queuedAt: new Date().toISOString(),
  brief: { title: 'x', request: 'x', acceptance: [], touches: [], feedback: [], answers: [] },
  stallSeconds: 360,
  sessionMinutes: 90,
  resources: { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 },
  launch: { fleetApi: 'http://127.0.0.1:8788', fleetToken: 'token', pathPrepend: [] },
});

const closeIssue: CloseIssueInput = {
  taskId: 't1',
  repo: { id: 'repo-1', owner: 'acme', name: 'demo', defaultBranch: 'main', testCommand: 'pnpm check' },
  issueNumber: 12,
  reason: 'completed',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('假世界', () => {
  it('会话剧本的 n 所有子任务一起数、own 按子任务自己数：readme 先起时 form 的第一次是 own 1、n 2', async () => {
    const seen: [string, number, number][] = [];
    const world = createFakeWorld({
      session: (input, n, own) => {
        seen.push([input.subtaskKey ?? '-', n, own]);
        return {};
      },
    });
    await world.ports.startSession(launchInput('readme', 'run-readme'), ctx);
    await world.ports.startSession(launchInput('form', 'run-form-1'), ctx);
    await world.ports.startSession(launchInput('form', 'run-form-2'), ctx);
    await world.ports.startSession(launchInput(undefined, 'run-own'), ctx);
    // 同一个 runId 再来（活动重试）：原样返回，不再数一次。
    await world.ports.startSession(launchInput('form', 'run-form-2'), ctx);
    expect(seen).toEqual([
      ['readme', 1, 1],
      ['form', 2, 1],
      ['form', 3, 2],
      ['-', 4, 1],
    ]);
  });

  it('until 只靠假世界的变化叫醒：钟停着（假计时器、一毫秒都不走）也等得到', async () => {
    vi.useFakeTimers();
    const world = createFakeWorld();
    let woke = false;
    const closed = world
      .until(() => world.count('closeIssue') === 1, '关单')
      .then(() => {
        woke = true;
      });
    await Promise.resolve();
    expect(woke).toBe(false);
    await world.ports.closeIssue(closeIssue, ctx);
    await closed;
    expect(woke).toBe(true);
  });

  it('until 等到挂着的会话开始看守；放行后看守照常收场', async () => {
    const world = createFakeWorld({ session: () => ({ hold: true }), heartbeatMs: 5 });
    const started = await world.ports.startSession(launchInput('form', 'run-form'), ctx);
    const held = world.until(() => world.held().length === 1, '会话挂着');
    const watching = world.ports.awaitSession(
      { taskId: 't1', subtaskKey: 'form', runId: 'run-form', sessionId: started.sessionId, stage: 'execute' },
      ctx,
    );
    await held;
    world.release(started.sessionId);
    await world.until(() => world.held().length === 0, '放行了');
    expect((await watching).outcome).toBe('done');
  });

  it('until 条件一直不成立：到点报错、写明在等什么，不当成等到了', async () => {
    const world = createFakeWorld();
    await expect(world.until(() => false, '永远不来的事', 30)).rejects.toThrow(
      '等了 30 毫秒还没等到：永远不来的事',
    );
  });

  it('until 的条件自己抛错：原样报出来；抛的是空值也报错，不当成等到了', async () => {
    const world = createFakeWorld();
    await expect(
      world.until(() => {
        throw new Error('条件里读坏了');
      }, '读坏的条件'),
    ).rejects.toThrow('条件里读坏了');
    await expect(
      world.until(() => {
        throw undefined;
      }, '抛空值的条件'),
    ).rejects.toThrow('查「抛空值的条件」时出错');
  });
});
