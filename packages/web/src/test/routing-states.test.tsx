// @vitest-environment happy-dom
// 路由页的状态词（#1366 第二部分，创始人要求把「死」拆开）：路由行、模型行、目录行都用路由八态的词和颜色，只有故障画红；
// 没配进任何用途的模型读不到判态的事实，不画态。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { RoutingLayers } from '../api/types';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(cleanup);

const opened = async () => {
  await screen.findByRole('navigation', { name: '用途' });
  await waitFor(() => expect(document.querySelector('li[data-route]')).not.toBeNull());
};

const pickModel = async (name: string) =>
  fireEvent.click(await screen.findByRole('button', { name: `查看 ${name} 的路由` }));

const routeItem = (routeId: string) => {
  const el = document.querySelector(`[data-route="${routeId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`页面上没有路由 ${routeId}`);
  return el;
};

/** 一条路由行上的状态芯片（第一个圆角底色的词）。 */
const chipOf = (routeId: string) => {
  const chip = routeItem(routeId).querySelector('span.rounded-full');
  if (!(chip instanceof HTMLElement)) throw new Error(`路由 ${routeId} 上没有状态芯片`);
  return chip;
};

const modelRow = (id: string) => document.querySelector(`li[data-model="${id}"]`) as HTMLElement;

describe('路由页的状态词：后端的「死」拆开，用路由八态，只有故障画红', () => {
  test('写码用途：探不通是故障（红）、开关关着是已关、模型下架是已下架；页面上没有单独的「死」「活」', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();
    expect(chipOf('r-ca-opus').textContent).toContain('在线');
    expect(chipOf('r-rl-opus').textContent).toContain('已关');
    expect(chipOf('r-rl-opus').className).not.toContain('text-ink-fail');
    await pickModel('Cursor Auto');
    expect(chipOf('r-cursor').textContent).toContain('故障');
    expect(chipOf('r-cursor').className).toContain('text-ink-fail');
    await pickModel('Opus 5');
    expect(chipOf('r-ca-opus5').textContent).toContain('已下架');
    expect(chipOf('r-ca-opus5').className).not.toContain('text-ink-fail');
    for (const span of Array.from(document.querySelectorAll('span'))) {
      expect(['死', '活']).not.toContain(span.textContent);
    }
  });

  test('模型行的状态点读屏写八态的词；整行只有故障那个点是红的', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();
    expect(modelRow('opus-5.5').textContent).toContain('：在线');
    expect(modelRow('cursor-auto').textContent).toContain('：故障');
    expect(modelRow('cursor-auto').querySelector('.bg-st-fail')).not.toBeNull();
    expect(modelRow('opus-5.5').querySelector('.bg-st-fail')).toBeNull();
    expect(modelRow('opus-5').textContent).toContain('：已下架');
    expect(modelRow('opus-5').querySelector('.bg-st-fail')).toBeNull();
  });

  test('额度用满是「暂时挡着」，不画红；「接得上」「额度够」那几件事也不再叫「死」', async () => {
    const now = Date.now();
    const fact = (verdict: 'live' | 'dead' | 'unknown', reason: string) => ({ verdict, reason });
    const layers: RoutingLayers = {
      asOf: new Date(now).toISOString(),
      purposes: [
        {
          purpose: 'execute',
          version: 0,
          verdict: 'dead',
          problems: [],
          models: [
            {
              modelId: 'opus-5.5',
              displayName: 'Opus 5.5',
              family: 'claude',
              verdict: 'dead',
              routes: [
                {
                  routeId: 'rt-q',
                  channelId: 'ch-claude',
                  channelName: 'Claude 订阅',
                  poolId: 'claude-a',
                  hostId: 'claude-code',
                  enabled: true,
                  verdict: 'dead',
                  connect: fact('live', '探针探通了'),
                  quota: fact('dead', '适用的额度窗用满了'),
                  ban: fact('live', '没有禁令、开关开着'),
                  probedAt: new Date(now - 60_000).toISOString(),
                  exhausted: [],
                  inFlight: 0,
                  reserved: 0,
                  maxConcurrency: 2,
                },
              ],
            },
          ],
        },
      ],
    };
    const api = Object.assign(createMockApi({ live: false }), { routingLayers: async () => layers });
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await opened();
    expect(chipOf('rt-q').textContent).toContain('暂时挡着');
    expect(chipOf('rt-q').className).not.toContain('text-ink-fail');
    expect(routeItem('rt-q').querySelector('.text-ink-fail')).toBeNull();
    expect(routeItem('rt-q').textContent).toContain('没过：适用的额度窗用满了');
    expect(modelRow('opus-5.5').textContent).toContain('：暂时挡着');
  });

  test('没配进任何用途的模型读不到判态的事实：模型目录里不画态，读屏写原因', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models' });
    await screen.findByRole('list', { name: '目录里的模型' });
    const fable = await waitFor(() => {
      const el = document.querySelector('li[data-catalog="fable-5.1"]');
      if (!el) throw new Error('目录里还没有 Fable');
      return el as HTMLElement;
    });
    expect(fable.textContent).toContain('：没配进用途，没算过');
    expect(fable.querySelector('.bg-st-fail, .bg-st-done, .bg-st-stall, .bg-st-stop')).toBeNull();
  });
});
