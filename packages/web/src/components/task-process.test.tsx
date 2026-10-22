// @vitest-environment happy-dom
// 任务页「过程」组件本身（#3533）：不经过任务页，直接拿假后端的详情渲染 TaskProcess。
// 页面级的回合、笔、引擎活动断言在 src/test/task-overview.test.tsx；这里补：刷新没成但有旧数据时画旧的加「刷新没成」条，
// 读不到的不画成 0，回合头的结局走状态字典。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { useTaskDetail } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { renderApp } from '../test/harness';
import { TaskProcess } from './task-process';

afterEach(cleanup);

const NOW = Date.parse('2026-10-21T12:00:00Z');

function Host({ id }: { id: string }) {
  const q = useTaskDetail(id);
  if (!q.data) return null;
  return <TaskProcess d={q.data} now={NOW} onViewTranscript={() => {}} inPanel />;
}

const found = async (selector: string, root: ParentNode = document) =>
  waitFor(() => {
    const el = root.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`${selector} 还没出来`);
    return el;
  });

describe('TaskProcess', () => {
  test('回合头的结局是状态字典里的词；返工回合写为什么返工', async () => {
    renderApp(<Host id="t-c9" />, { route: '/' });
    const r1 = await found('[data-round-header="1"]');
    expect(within(r1).getByText('超时').closest('[data-status]')?.getAttribute('data-status')).toBe(
      'task:round:timeout',
    );
    const r2 = await found('[data-round-header="2"]');
    expect(within(r2).getByText('做成了').closest('[data-status]')?.getAttribute('data-status')).toBe(
      'task:round:merged',
    );
    expect(r2.querySelector('[data-rework-why]')?.textContent).toMatch(/^为什么返工/);
  });

  test('回合表读不到：不判「进行中」也不编结局', async () => {
    // ?mockOverview=unread：假后端读的是 window.location
    window.history.replaceState({}, '', '/?mockOverview=unread');
    renderApp(<Host id="t-c9" />, { route: '/' });
    const proc = await found('[data-task-process]');
    expect(proc.textContent).toContain('回合没读到');
    expect(proc.textContent).toContain('引擎做的事没读到');
    const r2 = await found('[data-round-header="2"]');
    expect(r2.textContent).not.toContain('进行中');
    window.history.replaceState({}, '', '/');
  });

  test('这一笔的步骤刷新没成：旧步骤照画，顶上橙条写刷新没成并给重试；重试读回来条就没了', async () => {
    const api = createMockApi({ live: false });
    const real = api.runProcess.bind(api);
    let fail = false;
    api.runProcess = async (...args) => {
      if (fail) throw new Error('网关超时');
      return real(...args);
    };
    const { qc } = renderApp(<Host id="t-c9" />, { api, route: '/' });
    const run = await found('[data-run-process="seg-c9-3"]');
    await waitFor(() => expect(run.querySelectorAll('[data-step]').length).toBe(3));
    fail = true;
    await qc.refetchQueries({ queryKey: ['run-process'] });
    const alert = (await within(run).findByText(/刷新没成/)).closest('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('网关超时');
    // 旧步骤还在
    expect(run.querySelectorAll('[data-step]').length).toBe(3);
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(within(run).queryByText(/刷新没成/)).toBeNull());
    expect(run.querySelectorAll('[data-step]').length).toBe(3);
  });

  test('这一笔的步骤从没读成：写没读成和原因，不画成 0 步', async () => {
    const api = createMockApi({ live: false });
    api.runProcess = async () => {
      throw new Error('连不上后端');
    };
    renderApp(<Host id="t-c9" />, { api, route: '/' });
    const run = await found('[data-run-process="seg-c9-3"]');
    const alert = await within(run).findByRole('alert');
    expect(alert.textContent).toContain('这一笔的步骤没读成');
    expect(alert.textContent).toContain('连不上后端');
    expect(run.querySelectorAll('[data-step]')).toHaveLength(0);
    expect(screen.queryByText(/0 步/)).toBeNull();
  });
});
