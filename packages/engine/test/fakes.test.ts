// 假世界本身：测试靠它等事情发生，这样自己先得对（#88）。直接调端口，不起 Temporal。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeWorld } from '../src/fakes.ts';
import type { CloseIssueInput, PortContext } from '../src/ports.ts';

const ctx: PortContext = {
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
};

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
