// @vitest-environment happy-dom
// 路由页「模型目录」块上的渠道模型差集（#1302，#1366 第二部分挪到这一块）：只列，不放按钮。读不成不得写成「都对得上」。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { RoutingLayers } from '../api/types';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(cleanup);

const asOf = '2026-10-08T00:00:00.000Z';

function layers(over: Partial<RoutingLayers> = {}): RoutingLayers {
  return {
    asOf,
    purposes: [
      {
        purpose: 'execute',
        version: 0,
        verdict: 'dead',
        problems: ['这个用途没有模型，派不了'],
        models: [],
      },
    ],
    ...over,
  };
}

function withRoster(data: RoutingLayers): MockApi {
  const api = createMockApi({ live: false });
  return Object.assign(api, { routingLayers: async () => data });
}

describe('路由页：渠道模型表', () => {
  test('有新增、有消失：两头都列出来，没有按钮', async () => {
    renderApp(<RoutingPage />, {
      route: '/routing?tab=models',
      api: withRoster(
        layers({
          modelRoster: {
            missingFromCatalog: [
              {
                channelId: 'mirasim',
                channelName: 'Mirasim 中转',
                modelKey: 'kimi-k3',
                firstSeenAt: asOf,
                lastSeenAt: asOf,
              },
            ],
            goneRoutes: [
              {
                channelId: 'claude-sub',
                channelName: 'Claude 订阅',
                routeId: 'rt-sonnet',
                modelId: 'sonnet',
                upstreamModel: 'claude-sonnet-5-5',
              },
            ],
            failed: [],
            notYet: [],
          },
        }),
      ),
    });
    const section = await screen.findByRole('region', { name: '渠道模型表' });
    expect(section.textContent).toContain('渠道里有、目录里还没有的模型');
    expect(section.textContent).toContain('Mirasim 中转：kimi-k3');
    expect(section.textContent).toContain('目录里有、渠道已不认的路由');
    expect(section.textContent).toContain(
      'Claude 订阅 的路由 rt-sonnet（模型 sonnet，上游串 claude-sonnet-5-5）',
    );
    expect(section.textContent).not.toContain('都对得上');
    expect(within(section).queryByRole('button')).toBeNull();
  });

  test('没有差集时写明比的是渠道自己的模型表和目录，并写出各自的个数', async () => {
    renderApp(<RoutingPage />, {
      route: '/routing?tab=models',
      api: withRoster(
        layers({
          modelRoster: {
            missingFromCatalog: [],
            goneRoutes: [],
            failed: [],
            notYet: [],
            channelModelCount: 4,
            catalogCount: 7,
          },
        }),
      ),
    });
    const section = await screen.findByRole('region', { name: '渠道模型表' });
    expect(section.textContent?.trim()).toBe('渠道自己的模型表（4 个）和目录（7 个）对得上');
    expect(section.textContent).not.toBe('都对得上');
    expect(within(section).queryByRole('button')).toBeNull();
  });

  test('没有差集、接口没给个数：写明两边，不编数字', async () => {
    renderApp(<RoutingPage />, {
      route: '/routing?tab=models',
      api: withRoster(
        layers({
          modelRoster: { missingFromCatalog: [], goneRoutes: [], failed: [], notYet: [] },
        }),
      ),
    });
    const section = await screen.findByRole('region', { name: '渠道模型表' });
    expect(section.textContent?.trim()).toBe('渠道自己的模型表和目录对得上');
  });

  test('没有差集、只有手工登记：个数和手工登记一起写', async () => {
    renderApp(<RoutingPage />, {
      route: '/routing?tab=models',
      api: withRoster(
        layers({
          modelRoster: {
            missingFromCatalog: [],
            goneRoutes: [],
            failed: [],
            notYet: [],
            channelModelCount: 2,
            catalogCount: 2,
            manual: [{ channelId: 'claude-sub', channelName: 'Claude 订阅', count: 2 }],
          },
        }),
      ),
    });
    const section = await screen.findByRole('region', { name: '渠道模型表' });
    expect(section.textContent).toContain('渠道自己的模型表（2 个）和目录（2 个）对得上');
    expect(section.textContent).toContain('Claude 订阅：这个渠道靠手工登记，共 2 个');
    expect(within(section).queryByRole('button')).toBeNull();
  });

  test('【故意造出的失败】渠道没读成：不得显示成都对得上', async () => {
    renderApp(<RoutingPage />, {
      route: '/routing?tab=models',
      api: withRoster(
        layers({
          modelRoster: {
            missingFromCatalog: [],
            goneRoutes: [],
            failed: [
              {
                channelId: 'claude-sub',
                channelName: 'Claude 订阅',
                code: 'no_credentials',
                message: '没有登录',
              },
            ],
            notYet: [{ channelId: 'xai', channelName: 'Grok 订阅' }],
          },
        }),
      ),
    });
    const section = await screen.findByRole('region', { name: '渠道模型表' });
    expect(section.textContent).not.toContain('都对得上');
    expect(section.textContent).not.toContain('渠道自己的模型表');
    expect(section.textContent).toContain('Claude 订阅 没读成（no_credentials）：没有登录');
    expect(section.textContent).toContain('Grok 订阅 还没读过');
    expect(section.textContent).toContain('没有');
    expect(within(section).queryByRole('button')).toBeNull();
  });

  test('手工登记的渠道不报没读成，写靠手工登记、共几个', async () => {
    renderApp(<RoutingPage />, {
      route: '/routing?tab=models',
      api: withRoster(
        layers({
          modelRoster: {
            missingFromCatalog: [],
            goneRoutes: [],
            failed: [],
            notYet: [{ channelId: 'xai', channelName: 'Grok 订阅' }],
            manual: [{ channelId: 'claude-sub', channelName: 'Claude 订阅', count: 2 }],
          },
        }),
      ),
    });
    const section = await screen.findByRole('region', { name: '渠道模型表' });
    expect(section.textContent).toContain('Claude 订阅：这个渠道靠手工登记，共 2 个');
    expect(section.textContent).not.toContain('Claude 订阅 没读成');
    expect(section.textContent).toContain('Grok 订阅 还没读过');
    expect(within(section).queryByRole('button')).toBeNull();
  });

  test('接口没给差集：写没读到，页面上那一句不是「都对得上」', async () => {
    renderApp(<RoutingPage />, {
      route: '/routing?tab=models',
      api: withRoster(layers()),
    });
    const section = await screen.findByRole('region', { name: '渠道模型表' });
    expect(section.textContent?.trim()).toBe('渠道模型表没读到，不能当成都对得上');
    expect(section.textContent).not.toContain('渠道自己的模型表');
  });
});
