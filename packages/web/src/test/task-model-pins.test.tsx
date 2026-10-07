// @vitest-environment happy-dom
// 单子页「用哪个模型」（驾驶舱改版 2026-10-07）：动手、验收各一行写现在是指定还是自动、这一轮在跑的是谁；指定的模型派不出、
// 说不准时当场写明（引擎只等它、不换别的）；能回到自动。指定读不了、路由读不了都写明、下拉锁上，不拿「自动」冒充。
// 花费：执行体没报的按目录单价估、标「估算」；没有单价的写「没有单价」，不写 0。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { TaskDetail, UpdateTaskRoutePinBody } from '../api/types';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(cleanup);

function open(route: string, api?: FleetApi) {
  return renderApp(
    <Routes>
      <Route path="/tasks/:taskId" element={<TaskPage />} />
    </Routes>,
    { route, ...(api ? { api } : {}) },
  );
}

async function row(segment: string): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: '用哪个模型' });
  return waitFor(() => {
    const el = document.querySelector(`[data-pin-segment="${segment}"]`);
    if (!(el instanceof HTMLElement)) throw new Error(`没有 ${segment} 这一行`);
    return el;
  });
}

describe('用哪个模型', () => {
  test('#14：动手指定 Kimi（这一轮不打断）、验收指定 Grok；Grok 说不准派不派得出，写明引擎只等它、不换别的；对题写明指定不了', async () => {
    open('/tasks/t-14');
    const manual = await row('manual');
    expect(manual.textContent).toContain('指定 Kimi k3');
    expect(manual.textContent).toContain('想看看 Kimi 写得怎么样');
    const verify = await row('verify');
    expect(verify.textContent).toContain('指定 Grok 4.7');
    expect(verify.textContent).toContain('这一轮在跑的是 GPT 5.6 luna：不打断，下一轮起换');
    const alert = await waitFor(() => {
      const el = verify.querySelector('[data-pin-health]');
      if (!el) throw new Error('验收那一行没写 Grok 派不派得出');
      return el;
    });
    expect(alert.textContent).toContain('不会换别的模型');
    expect((await row('scope')).textContent).toContain('没有模型可指定');
  });

  test('回到自动：发给后端的是清掉这一段的指定，页面跟着变成自动', async () => {
    const inner = createMockApi({ live: false });
    const sent: UpdateTaskRoutePinBody[] = [];
    const api: FleetApi = {
      ...inner,
      updateTaskRoutePin: async (taskId, body) => {
        sent.push(body);
        return inner.updateTaskRoutePin(taskId, body);
      },
    };
    open('/tasks/t-14', api);
    const manual = await row('manual');
    fireEvent.click(within(manual).getByRole('button', { name: '回到自动' }));
    await waitFor(() => expect(sent).toEqual([{ segment: 'manual', modelId: null, routeId: null }]));
    await waitFor(() => expect(manual.textContent).toContain('自动'));
    expect(manual.textContent).not.toContain('指定 Kimi');
  });

  test('【故意造出的失败】指定读不了：写明读不了、下拉锁上，不当成「自动」', async () => {
    const inner = createMockApi({ live: false });
    const api: FleetApi = {
      ...inner,
      task: async (id) => {
        const d = await inner.task(id);
        return { ...d, routePins: { pins: [], unavailable: '没读成：库断了' } } satisfies TaskDetail;
      },
    };
    open('/tasks/t-14', api);
    await row('manual');
    expect(await screen.findByText(/指定读不了：没读成：库断了/)).toBeTruthy();
    const trigger = screen.getByRole('combobox', { name: '动手用哪个模型' });
    expect(trigger.hasAttribute('disabled') || trigger.getAttribute('data-disabled') !== null).toBe(true);
  });

  test('【故意造出的失败】指定的模型不在这个用途的路由两层里：写明引擎派不出、会停下等人', async () => {
    const inner = createMockApi({ live: false });
    const api: FleetApi = {
      ...inner,
      task: async (id) => {
        const d = await inner.task(id);
        return {
          ...d,
          routePins: {
            pins: [{ segment: 'manual', modelId: 'jev-9', setBy: 'u-lan', setAt: new Date().toISOString() }],
          },
        } satisfies TaskDetail;
      },
    };
    open('/tasks/t-14', api);
    const manual = await row('manual');
    const alert = await waitFor(() => {
      const el = manual.querySelector('[data-pin-health="dead"]');
      if (!el) throw new Error('没写派不出');
      return el;
    });
    expect(alert.textContent).toContain('不在「写码」用途的路由两层里');
  });
});

describe('每个环节的花费：没报的按目录单价估', () => {
  test('#14 动手有一笔订阅制没报花费：段那一格写「估算」，那一笔写估算的数；顶上花费写另估多少', async () => {
    open('/tasks/t-14');
    const box = (await screen.findByRole('heading', { name: '三段' })).closest('section');
    const manual = box?.querySelector('[data-segment="manual"]');
    expect(manual?.textContent).toContain('估算 $0.12');
    const run = await waitFor(() => {
      const el = document.querySelector('[data-run="seg-t-14-manual-170"]');
      if (!el) throw new Error('每一笔里没有那一笔');
      return el;
    });
    expect(run.textContent).toContain('估算 $0.12（按目录单价）');
    expect(screen.getByText(/另估 \$0\.12/)).toBeTruthy();
  });

  test('【故意造出的失败】目录里没有单价的模型（Kimi）：写「没有单价」，不写 $0', async () => {
    open('/tasks/t-c9');
    const run = await waitFor(() => {
      const el = document.querySelector('[data-run="seg-c9-2"]');
      if (!el) throw new Error('每一笔里没有 Kimi 那一笔');
      return el;
    });
    expect(run.querySelector('[data-estimate-gap]')?.textContent).toContain(
      '模型目录里没有「kimi-k3」的单价，估不了',
    );
    const manual = document.querySelector('[data-segment="manual"] [data-model="kimi-k3"]');
    expect(manual?.textContent).toContain('没有单价');
    expect(manual?.textContent).not.toContain('$0.00');
  });
});
