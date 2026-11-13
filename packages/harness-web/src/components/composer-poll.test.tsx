// @vitest-environment happy-dom
// 输入框下的报错：更早一次会话读取失败留下的字，下一次成功要清掉；晚到的失败回包不能再写上。
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdeSession } from '../lib/ade';

const pending = vi.hoisted(() => [] as { resolve: (v: unknown) => void; reject: (e: unknown) => void }[]);

vi.mock('../lib/ade', async () => {
  const actual = await vi.importActual<typeof import('../lib/ade')>('../lib/ade');
  return {
    ...actual,
    adeGet: () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  };
});

const { AdeComposer } = await import('./composer');

const session: AdeSession = {
  id: 's1',
  title: '新会话',
  status: 'idle',
  workspaceId: '',
  model: 'sonnet',
  worktree: true,
};

afterEach(() => {
  cleanup();
  pending.length = 0;
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('会话轮询的报错', () => {
  it('下一次读成功就清掉输入框下的报错', async () => {
    vi.useFakeTimers();
    render(<AdeComposer sessionId="s1" />);
    await flush();
    await act(async () => {
      pending[0]?.reject(new Error('没登录：缺本机令牌'));
    });
    expect(screen.getByRole('alert').textContent).toBe('没登录：缺本机令牌');

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      pending[1]?.resolve({ session });
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('session-meta').textContent).toContain('上下文 未知');
  });

  it('更早的失败比成功晚到，也不再把报错挂上', async () => {
    vi.useFakeTimers();
    render(<AdeComposer sessionId="s1" />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      pending[1]?.resolve({ session });
    });
    await act(async () => {
      pending[0]?.reject(new Error('没登录：缺本机令牌'));
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
