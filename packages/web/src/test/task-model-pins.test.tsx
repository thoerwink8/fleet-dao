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
import { estimateParts } from '../lib/usage';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(cleanup);

// 「用哪个模型」在「用量和模型」里，默认收起（#3228），地址带 ?usage=open 打开
function open(route: string, api?: FleetApi) {
  return renderApp(
    <Routes>
      <Route path="/tasks/:taskId" element={<TaskPage />} />
    </Routes>,
    { route: `${route}${route.includes('?') ? '&' : '?'}usage=open`, ...(api ? { api } : {}) },
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

function liveRow(segment: string): HTMLElement {
  const el = document.querySelector(`[data-pin-segment="${segment}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`没有 ${segment} 这一行`);
  return el;
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
    // 请求先记下、先不落库：忙态按钮文案是「正在回到自动」，里面就有「自动」，旧的指定还在。
    // 原先等「自动」会在落库前提前过，再拿点击前那一行同步查「指定 Kimi」；那一行被换掉后也不再跟着变。
    let releaseUpdate = () => {};
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const api: FleetApi = {
      ...inner,
      updateTaskRoutePin: async (taskId, body) => {
        sent.push(body);
        await updateGate;
        return inner.updateTaskRoutePin(taskId, body);
      },
    };
    try {
      open('/tasks/t-14', api);
      fireEvent.click(within(await row('manual')).getByRole('button', { name: '回到自动' }));
      await waitFor(() => expect(sent).toEqual([{ segment: 'manual', modelId: null, routeId: null }]));
      const inflight = liveRow('manual');
      expect(inflight.textContent).toContain('指定 Kimi');
      expect(inflight.textContent).not.toContain('按路由两层的顺序选');
      releaseUpdate();
      await waitFor(() => {
        const live = liveRow('manual');
        expect(live.textContent).toContain('自动');
        expect(live.textContent).toContain('按路由两层的顺序选');
        expect(live.textContent).not.toContain('指定 Kimi');
      });
    } finally {
      releaseUpdate();
    }
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
    expect(alert.textContent).toContain('不在「动手」用途的路由两层里');
  });
});

describe('现在就换（#1216）', () => {
  /** #12 动手正在跑 opus-5.5；给动手指定 Kimi（和在跑的不一样）。 */
  const pinnedKimi = (inner: FleetApi): FleetApi => ({
    ...inner,
    task: async (id) => {
      const d = await inner.task(id);
      return {
        ...d,
        routePins: {
          pins: [{ segment: 'manual', modelId: 'kimi-k3', setBy: 'u-lan', setAt: new Date().toISOString() }],
        },
      } satisfies TaskDetail;
    },
  });

  test('动手在跑、指定的和在跑的不一样：先写明代价（已做的从分支上接着做、token 不退），确认后发的是同一条指定加 now', async () => {
    const inner = createMockApi({ live: false });
    const sent: UpdateTaskRoutePinBody[] = [];
    const api: FleetApi = {
      ...pinnedKimi(inner),
      updateTaskRoutePin: async (taskId, body) => {
        sent.push(body);
        return inner.updateTaskRoutePin(taskId, body);
      },
    };
    open('/tasks/t-12', api);
    const manual = await row('manual');
    // 没点之前不发、也不先摆出确认
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(await within(manual).findByRole('button', { name: '现在就换' }));
    // 确认框盖在页面上（不再是行里的一条）：先写明代价
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('已花的 token 不退');
    expect(confirm.textContent).toContain('从分支上接着做');
    expect(sent).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: '确认现在就换' }));
    await waitFor(() =>
      expect(sent).toEqual([{ segment: 'manual', modelId: 'kimi-k3', routeId: null, now: true }]),
    );
  });

  test('【故意造出的失败】后端回 409（单子在这一刻不在跑了）：确认条留着、不当成换成了，发的就是那一条', async () => {
    const inner = createMockApi({ live: false });
    const sent: UpdateTaskRoutePinBody[] = [];
    const api: FleetApi = {
      ...pinnedKimi(inner),
      updateTaskRoutePin: async (_taskId, body) => {
        sent.push(body);
        throw new Error('这张单现在不在跑');
      },
    };
    open('/tasks/t-12', api);
    const manual = await row('manual');
    fireEvent.click(await within(manual).findByRole('button', { name: '现在就换' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认现在就换' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // 确认框留着、红字写原因（不当成换成了），确认键恢复能再点
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('这张单现在不在跑'));
    expect(within(dialog).getByRole('button', { name: '确认现在就换' })).toBeTruthy();
  });

  test('【故意造出的失败】没有在跑的动手会话（#14 动手上一轮已收场，在跑的是验收）：动手那一行没有「现在就换」；验收那一行也没有', async () => {
    open('/tasks/t-14', pinnedKimi(createMockApi({ live: false })));
    const manual = await row('manual');
    expect(within(manual).queryByRole('button', { name: '现在就换' })).toBeNull();
    const verify = await row('verify');
    expect(within(verify).queryByRole('button', { name: '现在就换' })).toBeNull();
  });
});

describe('每个环节的花费：没报的按目录单价估', () => {
  test('#14 动手有一笔订阅制没报花费：段那一格写「估算」，那一笔写估算的数；顶上花费写另估多少', async () => {
    open('/tasks/t-14');
    const box = (await screen.findByRole('heading', { name: '三段' })).closest('section');
    const manual = box?.querySelector('tr[data-row-key="manual"]');
    expect(manual?.textContent).toContain('估算 $0.12');
    const run = await waitFor(() => {
      const el = document.querySelector('tr[data-row-key="seg-t-14-manual-170"]');
      if (!el) throw new Error('每一笔里没有那一笔');
      return el;
    });
    expect(run.textContent).toContain('估算 $0.12（按目录单价）');
    expect(screen.getByText(/另估 \$0\.12/)).toBeTruthy();
  });

  test('【故意造出的失败】Kimi 有单价了，但这一笔缓存读写没读到：写「估不了」和缺哪几样，不写 $0、不写「没有单价」', async () => {
    open('/tasks/t-c9');
    const run = await waitFor(() => {
      const el = document.querySelector('tr[data-row-key="seg-c9-2"]');
      if (!el) throw new Error('每一笔里没有 Kimi 那一笔');
      return el;
    });
    expect(run.querySelector('[data-estimate-gap]')?.textContent).toContain('没读到缓存读、缓存写，估不了');
    const manual = document.querySelector('tr[data-row-key="manual/kimi-k3"]');
    expect(manual?.textContent).toContain('估不了');
    expect(manual?.textContent).not.toContain('没有单价');
    expect(manual?.textContent).not.toContain('$0.00');
  });

  test('【故意造出的失败】目录里写明没有按 token 单价的模型（Cursor Auto）：合计写「没有单价」，不写 $0', () => {
    const parts = estimateParts({ estimate: { runs: 0, usd: 0, noPrice: 1, noTokens: 0 } } as Parameters<
      typeof estimateParts
    >[0]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ key: 'noPrice', missing: '没有单价' });
    expect(JSON.stringify(parts)).not.toContain('$0');
  });
});
